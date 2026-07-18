{
  "targets": [
    {
      "target_name": "methodology_fs",
      "win_delay_load_hook": "false",
      "sources": ["src/addon.c", "src/common.c"],
      "conditions": [
        ["OS=='linux'", {
          "defines": ["AIH_NATIVE_FS_BACKEND_LINUX=1"],
          "sources": ["src/backend_linux.c"],
          "ldflags": ["-Wl,--as-needed"]
        }],
        ["OS=='win'", {
          "defines": ["AIH_NATIVE_FS_BACKEND_WINDOWS=1"],
          "sources": ["src/backend_windows.c"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "LanguageStandard_C": "stdc17",
              "WarningLevel": 4,
              "WarnAsError": "true"
            }
          }
        }],
        ["OS=='mac'", {
          "defines": ["AIH_NATIVE_FS_BACKEND_DARWIN=1"],
          "sources": ["src/backend_darwin.c"],
          "xcode_settings": {
            "DEAD_CODE_STRIPPING": "YES",
            "OTHER_CFLAGS": ["-std=c17", "-Wall", "-Wextra", "-Werror"],
            "OTHER_LDFLAGS": ["-Wl,-dead_strip", "-Wl,-dead_strip_dylibs"]
          }
        }],
        ["OS!='win'", {
          "cflags": ["-std=c17", "-Wall", "-Wextra", "-Werror"]
        }]
      ]
    }
  ]
}
