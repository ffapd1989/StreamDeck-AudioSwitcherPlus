//==============================================================================
/**
@file       AudioSwitcherStreamDeckPlugin.cpp

@brief      CPU plugin

@copyright  (c) 2018, Corsair Memory, Inc.
@copyright  (c) 2018-present, Fred Emmott.
@copyright  (c) 2026-present, Morgan Scruggs.
      This source code is licensed under the MIT-style license found in the
LICENSE file.

      Forked from Fred Emmott's original Audio Switcher plugin:
      https://github.com/fredemmott/StreamDeck-AudioOutputSwitcher
      All credit for the original plugin and design goes to Fred Emmott
      (https://github.com/fredemmott).

**/
//==============================================================================

#include "AudioSwitcherStreamDeckPlugin.h"

#include <AudioDevices/AudioDevices.h>
#include <StreamDeckSDK/EPLJSONUtils.h>
#include <StreamDeckSDK/ESDConnectionManager.h>
#include <StreamDeckSDK/ESDFilesystem.h>
#include <StreamDeckSDK/ESDLogger.h>
#include <StreamDeckSDK/ESDUtilities.h>

#include <websocketpp/base64/base64.hpp>

#include "ThirdParty/stb_image.h"
#include "ThirdParty/stb_image_write.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdlib>
#include <format>
#include <fstream>
#include <functional>
#include <iterator>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <vector>

#ifdef _MSC_VER
#include <objbase.h>
#endif
#include <Windows.h>
#include <ShlObj.h>
#include <shellapi.h>

#include "audio_json.h"

using namespace FredEmmott::Audio;
using json = nlohmann::json;

namespace {

ButtonRole ButtonRoleFromAudioDeviceRole(const AudioDeviceRole role) {
  switch (role) {
    case AudioDeviceRole::COMMUNICATION:
      return ButtonRole::COMMUNICATION;
    case AudioDeviceRole::DEFAULT:
      return ButtonRole::DEFAULT;
  }
  return ButtonRole::DEFAULT;
}

AudioDeviceRole AudioDeviceRoleFromButtonRole(const ButtonRole role) {
  switch (role) {
    case ButtonRole::COMMUNICATION:
      return AudioDeviceRole::COMMUNICATION;
    case ButtonRole::ALL:
    case ButtonRole::DEFAULT:
    default:
      return AudioDeviceRole::DEFAULT;
  }
}

// Whether `deviceID` is already the device for every role the button sets.
bool IsActiveForRole(
  const AudioDeviceDirection direction,
  const ButtonRole role,
  const std::string& deviceID) {
  if (role == ButtonRole::ALL) {
    return deviceID
      == GetDefaultAudioDeviceID(direction, AudioDeviceRole::DEFAULT)
      && deviceID
      == GetDefaultAudioDeviceID(direction, AudioDeviceRole::COMMUNICATION);
  }
  return deviceID
    == GetDefaultAudioDeviceID(direction, AudioDeviceRoleFromButtonRole(role));
}

void SetDefaultForRole(
  const AudioDeviceDirection direction,
  const ButtonRole role,
  const std::string& deviceID) {
  if (role == ButtonRole::ALL) {
    SetDefaultAudioDeviceID(direction, AudioDeviceRole::DEFAULT, deviceID);
    SetDefaultAudioDeviceID(
      direction, AudioDeviceRole::COMMUNICATION, deviceID);
    return;
  }
  SetDefaultAudioDeviceID(
    direction, AudioDeviceRoleFromButtonRole(role), deviceID);
}

// Devices that direction "both" switches together, each with its direction.
using DeviceList = std::vector<std::pair<AudioDeviceDirection, std::string>>;

// The configured ones of an output and an input, in that order.
DeviceList OutputAndInput(std::string outputID, std::string inputID) {
  DeviceList devices;
  if (!outputID.empty()) {
    devices.emplace_back(AudioDeviceDirection::OUTPUT, std::move(outputID));
  }
  if (!inputID.empty()) {
    devices.emplace_back(AudioDeviceDirection::INPUT, std::move(inputID));
  }
  return devices;
}

// The "Set" action's "both": its output and its input.
DeviceList BothDevices(const ButtonSettings& settings) {
  return OutputAndInput(
    settings.VolatilePrimaryID(), settings.VolatileSecondaryID());
}

// The "Toggle" action's "both": one of its two pairs - its primary or its
// secondary output, with the input that goes with it.
DeviceList TogglePairDevices(
  const ButtonSettings& settings,
  const bool primary) {
  return primary
    ? OutputAndInput(
        settings.VolatilePrimaryID(), settings.VolatilePrimaryInputID())
    : OutputAndInput(
        settings.VolatileSecondaryID(), settings.VolatileSecondaryInputID());
}

// Whether every one of `devices` is active; a device left unset doesn't count
// against it, but none set at all isn't.
bool AllActive(const DeviceList& devices, const ButtonRole role) {
  return !devices.empty()
    && std::ranges::all_of(devices, [role](const auto& device) {
         return IsActiveForRole(device.first, role, device.second);
       });
}

constexpr std::string_view SET_ACTION_ID{
  "com.morganscruggs.audioswitcherplus.set"};
constexpr std::string_view TOGGLE_ACTION_ID{
  "com.morganscruggs.audioswitcherplus.toggle"};
// Keys that only open Windows' sound settings: the classic Sound control panel
// (mmsys.cpl), and Sound in the Settings app.
constexpr std::string_view SOUND_CONTROL_PANEL_ACTION_ID{
  "com.morganscruggs.audioswitcherplus.soundcontrolpanel"};
constexpr std::string_view SOUND_SETTINGS_ACTION_ID{
  "com.morganscruggs.audioswitcherplus.soundsettings"};

// Windows' System32 folder; empty if it can't be found.
std::wstring SystemDirectory() {
  wchar_t path[MAX_PATH];
  const auto length = GetSystemDirectoryW(path, MAX_PATH);
  if (length == 0 || length >= MAX_PATH) {
    return {};
  }
  return std::wstring(path, length);
}

// Opens `file` - a program (given `parameters`) or a URI - as Explorer would,
// on a thread of its own: the shell wants a single-threaded COM apartment, and
// the plugin's event loop shouldn't wait while Windows starts it. `onFailure`
// runs on that thread if it couldn't be opened.
void ShellOpen(
  std::wstring file,
  std::wstring parameters,
  std::function<void()> onFailure) {
  std::thread([file = std::move(file),
               parameters = std::move(parameters),
               onFailure = std::move(onFailure)] {
    const auto com = CoInitializeEx(
      nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    // Started in the system folder rather than the plugin's own: a window
    // working in the plugin's folder keeps it from being updated or removed
    // while it's open.
    const auto directory = SystemDirectory();
    const auto result = ShellExecuteW(
      nullptr,
      L"open",
      file.c_str(),
      parameters.empty() ? nullptr : parameters.c_str(),
      directory.empty() ? nullptr : directory.c_str(),
      SW_SHOWNORMAL);
    if (SUCCEEDED(com)) {
      CoUninitialize();
    }
    // Only an HINSTANCE for compatibility: above 32 means it worked.
    if (reinterpret_cast<INT_PTR>(result) <= 32) {
      onFailure();
    }
  }).detach();
}

// Opens the classic Sound control panel, or (`settings`) Sound in the Settings
// app - for the keys that open them.
void OpenSoundWindow(const bool settings, std::function<void()> onFailure) {
  if (settings) {
    ShellOpen(L"ms-settings:sound", {}, std::move(onFailure));
  } else {
    ShellOpen(L"control.exe", L"mmsys.cpl", std::move(onFailure));
  }
}

std::string ToLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return s;
}

// Icon files live as `<id>.png`; the same artwork is reused and recolored at
// runtime for both "bright" and "dimmed" states rather than needing separate
// image files per state. Matching is case-insensitive since the files aren't
// guaranteed to be consistently cased.
std::optional<ESD::filesystem::path> FindIconFile(
  const std::string& iconsDirectory,
  const std::string& iconID) {
  if (iconsDirectory.empty()) {
    return std::nullopt;
  }
  std::error_code ec;
  const auto wanted = ToLower(iconID);
  for (const auto& entry :
       ESD::filesystem::directory_iterator(iconsDirectory, ec)) {
    if (!entry.is_regular_file()) {
      continue;
    }
    const auto& path = entry.path();
    if (ToLower(path.extension().string()) != ".png") {
      continue;
    }
    if (ToLower(path.stem().string()) == wanted) {
      return path;
    }
  }
  return std::nullopt;
}

json GetAvailableIconSets(const std::string& iconsDirectory) {
  auto result = json::array();
  if (iconsDirectory.empty()) {
    return result;
  }

  std::set<std::string> ids;
  std::error_code ec;
  for (const auto& entry :
       ESD::filesystem::directory_iterator(iconsDirectory, ec)) {
    if (!entry.is_regular_file()) {
      continue;
    }
    const auto& path = entry.path();
    if (ToLower(path.extension().string()) != ".png") {
      continue;
    }
    // Each icon has a "foo.png" / "foo@2x.png" pair for Stream Deck's
    // retina displays; both must collapse to the same "foo" id or the
    // @2x file shows up as a bogus extra icon in the picker.
    auto stem = ToLower(path.stem().string());
    constexpr std::string_view suffix2x = "@2x";
    if (stem.size() > suffix2x.size()
        && stem.compare(stem.size() - suffix2x.size(), suffix2x.size(), suffix2x) == 0) {
      stem.erase(stem.size() - suffix2x.size());
    }
    ids.insert(stem);
  }

  for (const auto& id: ids) {
    auto label = id;
    if (!label.empty()) {
      label[0] = static_cast<char>(std::toupper(label[0]));
    }
    result.push_back({{"id", id}, {"label", label}});
  }
  return result;
}

std::vector<unsigned char> ReadFileBytes(const ESD::filesystem::path& path) {
  ESD::ifstream file(path, std::ios::binary);
  if (!file) {
    return {};
  }
  const std::istreambuf_iterator<char> begin(file), end;
  return std::vector<unsigned char>(begin, end);
}

std::string ReadFileAsBase64(const ESD::filesystem::path& path) {
  const auto bytes = ReadFileBytes(path);
  return websocketpp::base64_encode(bytes.data(), bytes.size());
}

struct RGB {
  unsigned char r, g, b;
};

// Parses "#RRGGBB" or "RRGGBB"; returns nullopt for anything else, including
// an empty string (meaning "use the icon's original color").
std::optional<RGB> ParseHexColor(const std::string& hex) {
  auto s = hex;
  if (!s.empty() && s[0] == '#') {
    s = s.substr(1);
  }
  if (s.size() != 6
      || !std::all_of(s.begin(), s.end(), [](unsigned char c) {
           return std::isxdigit(c);
         })) {
    return std::nullopt;
  }
  const auto value = std::strtoul(s.c_str(), nullptr, 16);
  return RGB {
    static_cast<unsigned char>((value >> 16) & 0xFF),
    static_cast<unsigned char>((value >> 8) & 0xFF),
    static_cast<unsigned char>(value & 0xFF),
  };
}

void PngWriteCallback(void* context, void* data, int size) {
  auto* out = reinterpret_cast<std::string*>(context);
  out->append(reinterpret_cast<const char*>(data), static_cast<size_t>(size));
}

// Replaces the RGB of every pixel with `color`, leaving alpha untouched -
// the icons are monochrome silhouettes, so this recolors the shape while
// preserving its edge antialiasing.
std::string RecolorPngAsBase64(
  const std::vector<unsigned char>& pngBytes,
  const RGB& color) {
  int width = 0, height = 0, sourceChannels = 0;
  unsigned char* pixels = stbi_load_from_memory(
    pngBytes.data(),
    static_cast<int>(pngBytes.size()),
    &width,
    &height,
    &sourceChannels,
    4);
  if (!pixels) {
    return {};
  }

  const auto pixelCount = static_cast<size_t>(width) * height;
  for (size_t i = 0; i < pixelCount; ++i) {
    pixels[i * 4 + 0] = color.r;
    pixels[i * 4 + 1] = color.g;
    pixels[i * 4 + 2] = color.b;
  }

  std::string pngOut;
  stbi_write_png_to_func(
    &PngWriteCallback, &pngOut, width, height, 4, pixels, width * 4);
  stbi_image_free(pixels);

  return websocketpp::base64_encode(
    reinterpret_cast<const unsigned char*>(pngOut.data()), pngOut.size());
}

// The Sound control panel and Settings keys show the Sound control panel's
// own icon, at the size the other icons look on a key.
constexpr int KEY_IMAGE_SIZE = 144;
constexpr int SOUND_ICON_SIZE = 96;

// The Sound control panel's icon (resource 100 in mmsys.cpl) as a base64 PNG
// `size` pixels square; empty if Windows doesn't have it. It's Microsoft's
// artwork, so it's read from Windows rather than shipped with the plugin.
std::string SoundControlPanelIconBase64(const int size) {
  const auto systemDirectory = SystemDirectory();
  if (systemDirectory.empty()) {
    return {};
  }
  const auto file = systemDirectory + L"\\mmsys.cpl";
  HICON icon = nullptr;
  if (
    SHDefExtractIconW(
      file.c_str(), -100, 0, &icon, nullptr, static_cast<UINT>(size))
      != S_OK
    || !icon) {
    return {};
  }
  ICONINFO info {};
  const auto gotInfo = GetIconInfo(icon, &info);
  DestroyIcon(icon);
  if (!gotInfo) {
    return {};
  }

  // Its color bitmap, as top-down 32-bit BGRA with the icon's alpha.
  BITMAPINFO bitmapInfo {};
  bitmapInfo.bmiHeader.biSize = sizeof(bitmapInfo.bmiHeader);
  bitmapInfo.bmiHeader.biWidth = size;
  bitmapInfo.bmiHeader.biHeight = -size;
  bitmapInfo.bmiHeader.biPlanes = 1;
  bitmapInfo.bmiHeader.biBitCount = 32;
  bitmapInfo.bmiHeader.biCompression = BI_RGB;
  std::vector<unsigned char> pixels(static_cast<size_t>(size) * size * 4);
  const auto dc = GetDC(nullptr);
  const auto rows = info.hbmColor
    ? GetDIBits(
        dc,
        info.hbmColor,
        0,
        size,
        pixels.data(),
        &bitmapInfo,
        DIB_RGB_COLORS)
    : 0;
  ReleaseDC(nullptr, dc);
  DeleteObject(info.hbmColor);
  DeleteObject(info.hbmMask);
  if (rows != size) {
    return {};
  }
  for (size_t i = 0; i < pixels.size(); i += 4) {
    std::swap(pixels[i], pixels[i + 2]);
  }

  std::string png;
  stbi_write_png_to_func(
    &PngWriteCallback, &png, size, size, 4, pixels.data(), size * 4);
  return websocketpp::base64_encode(
    reinterpret_cast<const unsigned char*>(png.data()), png.size());
}

// A key image of the Sound control panel's icon (a base64 PNG) at (offset,
// offset), with the key-sized base64 PNG `overlay` over it unless that's
// empty - as an SVG, which Stream Deck takes as it would a PNG.
std::string SoundKeyImage(
  const std::string& icon,
  const int offset,
  const std::string& overlay) {
  auto svg = std::format(
    R"(<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{0}" height="{0}" viewBox="0 0 {0} {0}">)"
    R"(<image x="{1}" y="{1}" width="{2}" height="{2}" xlink:href="data:image/png;base64,{3}"/>)",
    KEY_IMAGE_SIZE,
    offset,
    SOUND_ICON_SIZE,
    icon);
  if (!overlay.empty()) {
    svg += std::format(
      R"(<image width="{0}" height="{0}" xlink:href="data:image/png;base64,{1}"/>)",
      KEY_IMAGE_SIZE,
      overlay);
  }
  svg += "</svg>";
  return "data:image/svg+xml;base64," + websocketpp::base64_encode(svg);
}

bool FillAudioDeviceInfo(AudioDeviceInfo& di) {
  if (di.id.empty()) {
    return false;
  }
  if (!di.displayName.empty()) {
    return false;
  }

  const auto devices = GetAudioDeviceList(di.direction);
  if (!devices.contains(di.id)) {
    return false;
  }
  di = devices.at(di.id);
  return true;
}

}// namespace

AudioSwitcherStreamDeckPlugin::AudioSwitcherStreamDeckPlugin() {
#ifdef _MSC_VER
  CoInitializeEx(
    NULL, COINIT_MULTITHREADED);// initialize COM for the main thread
#endif
  mCallbackHandle = AddDefaultAudioDeviceChangeCallback(std::bind_front(
    &AudioSwitcherStreamDeckPlugin::OnDefaultDeviceChanged, this));

  // GetPluginDirectoryPath() only returns a valid path on its first call
  // (subsequent calls return an empty path), so cache it once here.
  const auto pluginDir = ESDUtilities::GetPluginDirectoryPath();
  if (!pluginDir.empty()) {
    mIconsDirectory = (pluginDir / "AudioDevicesIcons").string();
    mSettingsIconsDirectory = (pluginDir / "SettingsIcons").string();
  }
}

AudioSwitcherStreamDeckPlugin::~AudioSwitcherStreamDeckPlugin() {
  mCallbackHandle = {};
}

void AudioSwitcherStreamDeckPlugin::OnDefaultDeviceChanged(
  AudioDeviceDirection direction,
  AudioDeviceRole role,
  const std::string& device) {
  std::scoped_lock lock(mButtonsMutex);
  for (const auto& [context, button] : mButtons) {
    if (!button.settings.bothDirections
        && button.settings.direction != direction) {
      continue;
    }
    const auto buttonRole = ButtonRoleFromAudioDeviceRole(role);
    if (button.settings.role != ButtonRole::ALL
        && button.settings.role != buttonRole) {
      continue;
    }
    UpdateState(context, device);
  }
}

void AudioSwitcherStreamDeckPlugin::KeyUpForAction(
  const std::string& inAction,
  const std::string& inContext,
  const json& inPayload,
  const std::string& inDeviceID) {
  ESDDebug("{}: {}", __FUNCTION__, inPayload.dump());

  if (
    inAction == SOUND_CONTROL_PANEL_ACTION_ID
    || inAction == SOUND_SETTINGS_ACTION_ID) {
    OpenSoundWindow(inAction == SOUND_SETTINGS_ACTION_ID, [this, inContext] {
      mConnectionManager->ShowAlertForContext(inContext);
    });
    return;
  }

  std::scoped_lock lock(mButtonsMutex);

  if (!inPayload.contains("settings")) {
    return;
  }
  auto& button = mButtons[inContext];
  button.rawSettings = inPayload.at("settings");
  button.settings = button.rawSettings;
  const auto& settings = button.settings;
  FillButtonDeviceInfo(inContext);

  const auto state = EPLJSONUtils::GetIntByName(inPayload, "state");

  if (settings.bothDirections) {
    // Sets an output and an input device together: the "Set" action's own,
    // or the "Toggle" action's pair it isn't showing (picked as for a single
    // device, below). One that's unplugged is skipped with an alert rather
    // than holding back the other.
    const auto isSet = inAction == SET_ACTION_ID;
    const auto devices = isSet ? BothDevices(settings)
                               : TogglePairDevices(settings, state != 0);
    if (devices.empty()) {
      ESDDebug("Doing nothing, no device ID");
      if (!isSet) {
        UpdateState(inContext);
      }
      return;
    }
    bool missing = false;
    bool changed = false;
    for (const auto& [direction, deviceID]: devices) {
      if (GetAudioDeviceState(deviceID) != AudioDeviceState::CONNECTED) {
        missing = true;
        continue;
      }
      if (IsActiveForRole(direction, settings.role, deviceID)) {
        continue;
      }
      ESDDebug("Setting device to {}", deviceID);
      SetDefaultForRole(direction, settings.role, deviceID);
      changed = true;
    }
    if (!isSet) {
      // Stream Deck flipped the key on press; a press that changed nothing
      // puts it back to what's active (a change does that itself, through
      // OnDefaultDeviceChanged).
      if (!changed) {
        UpdateState(inContext);
      }
      if (missing) {
        mConnectionManager->ShowAlertForContext(inContext);
      }
      return;
    }
    if (missing) {
      mConnectionManager->SetState(1, inContext);
      mConnectionManager->ShowAlertForContext(inContext);
    } else if (!changed) {
      // We already have the correct devices, undo the state change
      mConnectionManager->SetState(state, inContext);
      ESDDebug("Already set, nothing to do");
    }
    return;
  }

  // this looks inverted - but if state is 0, we want to move to state 1, so
  // we want the secondary devices. if state is 1, we want state 0, so we want
  // the primary device
  const auto deviceID = (state != 0 || inAction == SET_ACTION_ID)
    ? settings.VolatilePrimaryID()
    : settings.VolatileSecondaryID();
  if (deviceID.empty()) {
    ESDDebug("Doing nothing, no device ID");
    return;
  }

  const auto deviceState = GetAudioDeviceState(deviceID);
  if (deviceState != AudioDeviceState::CONNECTED) {
    if (inAction == SET_ACTION_ID) {
      mConnectionManager->SetState(1, inContext);
    }
    mConnectionManager->ShowAlertForContext(inContext);
    return;
  }

  if (
    inAction == SET_ACTION_ID
    && IsActiveForRole(settings.direction, settings.role, deviceID)) {
    // We already have the correct device, undo the state change
    mConnectionManager->SetState(state, inContext);
    ESDDebug("Already set, nothing to do");
    return;
  }

  ESDDebug("Setting device to {}", deviceID);
  SetDefaultForRole(settings.direction, settings.role, deviceID);
}

void AudioSwitcherStreamDeckPlugin::WillAppearForAction(
  const std::string& inAction,
  const std::string& inContext,
  const json& inPayload,
  const std::string& inDeviceID) {
  // Only device keys have a state to keep up to date; the Sound control panel
  // and Settings keys just draw their icon, and open their window when pressed.
  if (
    inAction == SOUND_CONTROL_PANEL_ACTION_ID
    || inAction == SOUND_SETTINGS_ACTION_ID) {
    ApplySoundKeyIcon(inAction, inContext);
    return;
  }
  std::scoped_lock lock(mButtonsMutex);
  auto& button = mButtons[inContext];
  button = {inAction, inContext};

  if (!inPayload.contains("settings")) {
    return;
  }
  button.rawSettings = inPayload.at("settings");
  button.settings = button.rawSettings;

  UpdateState(inContext);
  FillButtonDeviceInfo(inContext);
  ApplyIcon(inContext);
}

void AudioSwitcherStreamDeckPlugin::FillButtonDeviceInfo(
  const std::string& context) {
  auto& button = mButtons.at(context);
  auto& settings = button.settings;

  // Every one is filled in (no short-circuiting), then saved once.
  const auto filledPrimary = FillAudioDeviceInfo(settings.primaryDevice);
  const auto filledSecondary = FillAudioDeviceInfo(settings.secondaryDevice);
  const auto filledPrimaryInput
    = FillAudioDeviceInfo(settings.primaryInputDevice);
  const auto filledSecondaryInput
    = FillAudioDeviceInfo(settings.secondaryInputDevice);
  if (filledPrimary || filledSecondary || filledPrimaryInput
      || filledSecondaryInput) {
    // Merge over the original payload so keys ButtonSettings doesn't model survive the write-back.
    auto merged = button.rawSettings.is_object() ? button.rawSettings : json::object();
    merged.update(json(settings));
    button.rawSettings = merged;
    ESDDebug("Backfilling settings to {}", merged.dump());
    mConnectionManager->SetSettings(merged, context);
  }
}

namespace {
void ApplyStateImage(
  ESDConnectionManager* connectionManager,
  const std::string& iconsDirectory,
  const std::string& iconID,
  const std::string& hexColor,
  const std::string& context,
  int state) {
  const auto file = FindIconFile(iconsDirectory, iconID);
  if (!file) {
    return;
  }

  const auto color = ParseHexColor(hexColor);
  const auto base64Image = color
    ? RecolorPngAsBase64(ReadFileBytes(*file), *color)
    : ReadFileAsBase64(*file);
  if (base64Image.empty()) {
    return;
  }
  connectionManager->SetImage(
    base64Image, context, kESDSDKTarget_HardwareAndSoftware, state);
}
}// namespace

void AudioSwitcherStreamDeckPlugin::ApplyIcon(const std::string& context) {
  const auto it = mButtons.find(context);
  if (it == mButtons.end()) {
    return;
  }
  const auto& button = it->second;

  if (button.action == SET_ACTION_ID) {
    // No explicit choice yet defaults to the headphones icon (works for
    // both input and output buttons) rather than the plugin's built-in
    // generic images.
    const auto& iconID = button.settings.icon.empty()
      ? std::string {"headphones"}
      : button.settings.icon;
    ApplyStateImage(
      mConnectionManager,
      mIconsDirectory,
      iconID,
      button.settings.iconBrightColor,
      context,
      0);
    // Reuses the same artwork for the inactive state rather than a
    // separate dark image file, recolored neutral grey by default so it
    // still reads as "dimmed" without needing per-color dark art.
    const auto& darkColor = button.settings.iconDarkColor.empty()
      ? std::string {"#606060"}
      : button.settings.iconDarkColor;
    ApplyStateImage(
      mConnectionManager,
      mIconsDirectory,
      iconID,
      darkColor,
      context,
      1);
    return;
  }

  if (button.action == TOGGLE_ACTION_ID) {
    // The two states represent two different devices, not one device's
    // active/inactive state, so each gets its own icon choice - defaulting
    // to the plugin's original headphones/speaker pairing.
    const auto& primaryIconID = button.settings.primaryIcon.empty()
      ? std::string {"headphones"}
      : button.settings.primaryIcon;
    const auto& secondaryIconID = button.settings.secondaryIcon.empty()
      ? std::string {"speaker"}
      : button.settings.secondaryIcon;
    ApplyStateImage(
      mConnectionManager,
      mIconsDirectory,
      primaryIconID,
      button.settings.primaryIconColor,
      context,
      0);
    ApplyStateImage(
      mConnectionManager,
      mIconsDirectory,
      secondaryIconID,
      button.settings.secondaryIconColor,
      context,
      1);
  }
}

std::string AudioSwitcherStreamDeckPlugin::SoundKeyImageFor(
  const bool withGear) {
  // Read once - Windows' icon doesn't change while the plugin runs.
  static const auto icon = SoundControlPanelIconBase64(SOUND_ICON_SIZE);
  if (icon.empty()) {
    return {};
  }
  if (!withGear) {
    return SoundKeyImage(icon, (KEY_IMAGE_SIZE - SOUND_ICON_SIZE) / 2, {});
  }
  // The same speaker, moved up and left for the gear.
  const auto gear = ReadFileAsBase64(
    ESD::filesystem::path(mSettingsIconsDirectory)
    / "sound-settings-badge.png");
  return SoundKeyImage(icon, 14, gear);
}

void AudioSwitcherStreamDeckPlugin::ApplySoundKeyIcon(
  const std::string& action,
  const std::string& context) {
  // Without Windows' icon, the key keeps the manifest's own image.
  const auto image = SoundKeyImageFor(action == SOUND_SETTINGS_ACTION_ID);
  if (image.empty()) {
    return;
  }
  mConnectionManager->SetImage(
    image, context, kESDSDKTarget_HardwareAndSoftware, 0);
}

void AudioSwitcherStreamDeckPlugin::WillDisappearForAction(
  const std::string& inAction,
  const std::string& inContext,
  const json& inPayload,
  const std::string& inDeviceID) {
  std::scoped_lock lock(mButtonsMutex);
  mButtons.erase(inContext);
}

void AudioSwitcherStreamDeckPlugin::SendToPlugin(
  const std::string& inAction,
  const std::string& inContext,
  const json& inPayload,
  const std::string& inDeviceID) {
  json outPayload;

  const auto event = EPLJSONUtils::GetStringByName(inPayload, "event");
  ESDDebug("Received event {}", event);

  if (event == "getDeviceList") {
    const auto outputList = GetAudioDeviceList(AudioDeviceDirection::OUTPUT);
    const auto inputList = GetAudioDeviceList(AudioDeviceDirection::INPUT);
    mConnectionManager->SendToPropertyInspector(
      inAction,
      inContext,
      json({
        {"event", event},
        {"outputDevices", outputList},
        {"inputDevices", inputList},
      }));
    return;
  }

  if (event == "getIconList") {
    mConnectionManager->SendToPropertyInspector(
      inAction,
      inContext,
      json({
        {"event", event},
        {"icons", GetAvailableIconSets(mIconsDirectory)},
      }));
    return;
  }
}

void AudioSwitcherStreamDeckPlugin::UpdateState(
  const std::string& context,
  const std::string& optionalDefaultDevice) {
  std::scoped_lock lock(mButtonsMutex);
  const auto it = mButtons.find(context);
  if (it == mButtons.end()) {
    return;
  }
  const auto& action = it->second.action;
  const auto& settings = it->second.settings;

  if (settings.bothDirections && action == SET_ACTION_ID) {
    // On only while its output and its input are both active; one left
    // unset doesn't count against it.
    const auto on = AllActive(BothDevices(settings), settings.role);
    mConnectionManager->SetState(on ? 0 : 1, context);
    return;
  }

  if (settings.bothDirections) {
    // The "Toggle" action shows whichever of its pairs is active - every
    // device the pair has set is - and, as for a single device, alerts when
    // neither is.
    if (AllActive(TogglePairDevices(settings, true), settings.role)) {
      mConnectionManager->SetState(0, context);
      return;
    }
    if (AllActive(TogglePairDevices(settings, false), settings.role)) {
      mConnectionManager->SetState(1, context);
      return;
    }
    mConnectionManager->ShowAlertForContext(context);
    return;
  }

  const auto primaryID = settings.VolatilePrimaryID();
  const auto secondaryID = settings.VolatileSecondaryID();

  std::string activeDevice;
  if (!optionalDefaultDevice.empty()) {
    activeDevice = optionalDefaultDevice;
  } else if (settings.role == ButtonRole::ALL) {
    activeDevice = GetDefaultAudioDeviceID(
      settings.direction,
      AudioDeviceRole::DEFAULT);
    if (activeDevice.empty() || activeDevice == secondaryID || activeDevice == primaryID) {
      activeDevice = GetDefaultAudioDeviceID(
        settings.direction,
        AudioDeviceRole::COMMUNICATION);
    }
  } else {
    activeDevice = GetDefaultAudioDeviceID(
      settings.direction,
      AudioDeviceRoleFromButtonRole(settings.role));
  }

  if (action == SET_ACTION_ID) {
    mConnectionManager->SetState(activeDevice == primaryID ? 0 : 1, context);
    return;
  }

  if (activeDevice == primaryID) {
    mConnectionManager->SetState(0, context);
    return;
  }

  if (activeDevice == secondaryID) {
    mConnectionManager->SetState(1, context);
    return;
  }

  mConnectionManager->ShowAlertForContext(context);
}

void AudioSwitcherStreamDeckPlugin::DeviceDidConnect(
  const std::string& inDeviceID,
  const json& inDeviceInfo) {
  // Nothing to do
}

void AudioSwitcherStreamDeckPlugin::DeviceDidDisconnect(
  const std::string& inDeviceID) {
  // Nothing to do
}

void AudioSwitcherStreamDeckPlugin::DidReceiveGlobalSettings(
  const json& inPayload) {
}

void AudioSwitcherStreamDeckPlugin::DidReceiveSettings(
  const std::string& inAction,
  const std::string& inContext,
  const json& inPayload,
  const std::string& inDeviceID) {
  WillAppearForAction(inAction, inContext, inPayload, inDeviceID);
}
