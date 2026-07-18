{
  "targets": [
    {
      "target_name": "methodology_fs",
      "sources": ["src/addon.c", "src/common.c"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "WarningLevel": 4,
              "WarnAsError": "true"
            }
          }
        }],
        ["OS!='win'", {
          "cflags": ["-std=c17", "-Wall", "-Wextra", "-Werror"],
          "xcode_settings": {
            "OTHER_CFLAGS": ["-std=c17", "-Wall", "-Wextra", "-Werror"]
          }
        }]
      ]
    }
  ]
}
