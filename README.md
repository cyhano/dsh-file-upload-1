# dsh-file-upload ⬆️

[English](README.md) | [简体中文](README.zh-CN.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**One upload button + drag-and-drop files straight into the conversation** — a plugin for DeepSeek Harness (`dsh`) web.

*Unofficial project: independently developed and maintained by a community member, not an official DeepSeek product.*

## Screenshot

![dsh-file-upload in action](assets/screenshot.png)

The upload icon button in the composer tool row (official DSH design tokens, follows dark/light theme); the picked file's path (blurred in the screenshot) is inserted into the input box automatically, ready to send.

## Features

| Action | Effect |
|---|---|
| Click upload icon | System file picker (multi-select) → save → path into the input box |
| Drag a file into the window | Images & any file type are taken over (no "unsupported" toast) → save → path into the input box |
| Drag a folder into the window | Recursively reads the whole folder → rebuilds it under the upload directory with its original layout → only the folder path goes into the input box (contents not expanded) |
| Send the message | The model / vision tool reads the file by absolute path |
| Switch sessions | Button follows the current session; files land in the configured upload directory |

- Single-file limit: 25 MB (frontend) / 30 MB (backend); folder total 60 MB
- Filenames keep Chinese/space characters; a timestamp + random prefix avoids collisions
- Button shows busy state while uploading; failures surface as Chinese notices

## Configuration

The upload directory and path prefix are configurable in the DSH settings panel (`Settings → Plugins → File upload`):

| Setting | Default | Description |
|---|---|---|
| Upload directory | `/tmp` | Root directory where files and folders are written; empty falls back to `/tmp` |
| Prefix text | `[上传文件]` | Text prepended to paths in the input box; empty means no prefix |

> Settings persist through the `dsh-file-upload` settings namespace (stored in settings.yaml).
> You can also override the upload directory with the `DSH_UPLOAD_DIR` environment variable (highest priority).

## Install

Official bundle install (one line):

```sh
dsh plugin --profile web add "github:a903067276-rgb/dsh-file-upload#main"
```

Restart `dsh web` (bundle layers are composed at startup). Requires pnpm on PATH (`dsh plugin` forwards to pnpm).

Manual mount (fallback): see [docs/install.md](docs/install.md) — symlink into `~/.dsh/profiles/web/node_modules/` plus a **single entry** in `~/.dsh/cordis.patch.yml` (a double entry makes the plugin apply twice and crash on duplicate route registration), then restart.

## Usage

1. Click the upload icon and pick files (multi-select), or drag files/folders anywhere into the window.
2. The file is saved under the configured upload directory (default `/tmp`); the input box gets `<prefix> <absolute path>` lines — e.g. `[上传文件] /tmp/xxx.png` — with the prefix configurable (or removable) in settings, and your existing draft text is kept.
3. Press send; the model — or any attached vision tool — reads the file by path.

## Platform support

| Platform | Status |
|---|---|
| macOS | ✅ fully tested (development environment) |
| Linux | ✅ expected to work (pure Node implementation), untested |
| Windows | ⚠️ expected to work (pure Node implementation, Windows-safe filename sanitization, platform separator paths), untested |

## Requirements

- DSH web >= 0.1.0-rc.7 (run with `dsh web`)
- No extra shell needed: the host half is pure Node (`node:fs`), no system commands required on any platform.

## How it works

- **Host** (`lib/index.js`): two routes — `POST /api/file-upload/save` (single file, base64 payload) and `POST /api/file-upload/save-folder` (a folder: file list + relative paths). After session/size/same-origin checks, it writes with **pure Node** (`node:fs`, no system command dependency, cross-platform) under the configured upload directory; returned paths use `node:path` and follow the platform separator, and responses carry the current prefix. The two settings (upload directory, prefix) are registered through the `dsh-settings` namespace with a typed schema and apply live.
- **Client** (`lib/client.js`): registers the upload icon button in the `conversation.input.left` seat (visually distinct from the default "+" command button); a capture-phase document listener takes over file drags before the official InputBar's bubble-phase listener (which would reject images); dragged folders are read recursively via `webkitGetAsEntry()` and sent to save-folder. `FileReader` reads base64, uploads it, then the path text (with the configured prefix) is appended to the input draft (`inputActions.setDraft`). A `settings.plugin.item` card exposes the two settings through `settingsScope`.
- **Error boundary**: a render crash degrades to a small "upload component error" chip instead of unmounting the whole composer.

## Notes

- The upload directory only grows; it is **never cleaned automatically** (we don't delete your files) — remove files manually when needed.
- After modifying the plugin, restart `dsh web` for changes to take effect (client-side edits apply on a page refresh; host edits need a restart).
- Settings appear in the panel on dsh >= 0.1.0-rc.7; earlier versions rely on the `DSH_UPLOAD_DIR` environment variable only.

## Why this plugin exists

DSH natively rejects dragged-in images when the current model doesn't support them (official toast: "the current model does not support images"). This plugin saves the file to disk first and puts a **path text** into the conversation instead — a plain-text message that passes the model's image check and works with any model or vision plugin.

**Vision-plugin agnostic**: the message only carries a local absolute path (plain text), so it works with dsh-vision's `view_image`, any other model/tool that can read local paths, or no vision at all. It bypasses DSH's native image rejection because no image block is ever submitted.

## License

[MIT](LICENSE)
