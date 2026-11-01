{
  "Actions": [
    {
      "States": [
        {
          "Image": "AudioDevicesIcons/headphones"
        },
        {
          "Image": "AudioDevicesIcons/speaker"
        }
      ],
      "SupportedInMultiActions": false,
      "Icon": "AudioDevicesIcons/headphones",
      "Name": "Toggle Audio Device",
      "Tooltip": "Switch between two audio devices.",
      "UUID": "com.morganscruggs.audioswitcherplus.toggle",
      "PropertyInspectorPath": "propertyinspector/index.html"
    },
    {
      "SupportedInMultiActions": true,
      "Icon": "AudioDevicesIcons/headphones",
      "Name": "Set Audio Device",
      "Tooltip": "Set a specific audio device",
      "UUID": "com.morganscruggs.audioswitcherplus.set",
      "PropertyInspectorPath": "propertyinspector/index.html",
      "States": [
        {
          "Image": "AudioDevicesIcons/headphones"
        },
        {
          "Image": "AudioDevicesIcons/headphones"
        }
      ]
    },
    {
      "SupportedInMultiActions": true,
      "Icon": "SettingsIcons/sound-control-panel",
      "Name": "Sound Control Panel",
      "Tooltip": "Open the classic Sound control panel (mmsys.cpl).",
      "UUID": "com.morganscruggs.audioswitcherplus.soundcontrolpanel",
      "States": [
        {
          "Image": "SettingsIcons/sound-control-panel"
        }
      ]
    },
    {
      "SupportedInMultiActions": true,
      "Icon": "SettingsIcons/sound-settings",
      "Name": "Sound Settings",
      "Tooltip": "Open Sound in Windows Settings.",
      "UUID": "com.morganscruggs.audioswitcherplus.soundsettings",
      "States": [
        {
          "Image": "SettingsIcons/sound-settings"
        }
      ]
    }
  ],
  "Author": "Morgan Scruggs",
  "CodePath": "sdaudioswitchplus.exe",
  "Description": "Toggle or set the active audio devices (native exe build). Based on Fred Emmott's Audio Switcher (github.com/fredemmott).",
  "Name": "Audio Switcher Plus (exe)",
  "Icon": "AudioDevicesIcons/headphones",
  "Category": "Audio Switcher Plus (exe)",
  "CategoryIcon": "AudioDevicesIcons/speaker",
  "Version": "${CMAKE_PROJECT_VERSION}",
  "OS": [
    {
      "Platform": "windows",
      "MinimumVersion": "10"
    }
  ],
  "SDKVersion": 2,
  "Software": {
    "MinimumVersion": "6.4"
  },
  "UUID": "com.morganscruggs.audioswitcherplus"
}
