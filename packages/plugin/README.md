# dsh-crewboard

Crewboard’s DeepSeek Harness plugin adds the Crewboard screen, settings, notifications, and `orchestra_*` tools to dsh.

```sh
dsh plugin --profile web add dsh-crewboard
```

Requires Node.js 24 or newer and a dsh `web` profile. Set the plugin's `repos` setting to absolute repository paths, or start dsh with `CREWBOARD_REPOS` (colon-separated absolute paths). Then open **Orchestration** in the dsh sidebar.

See the [Crewboard repository](https://github.com/Kjaly/crewboard#readme) and the [plugin setup guide](https://github.com/Kjaly/crewboard/blob/main/docs/en/plugin-setup.md).
