# Offline bundle

A bundle is one archive, built on a machine with network, that holds everything Code ARC otherwise downloads:

- the pinned pip zipapp (`PIP_PYZ_URL` / `PIP_PYZ_SHA256` in `src/bootstrap.js`);
- a wheel for every pin in `requirements.txt`;
- every game's Python source, as the toolkit downloads it.

With a bundle active, the backend verifies it at every boot, installs the venv from it with no download, and plays the bundle's games locally with no network. **Online play is unchanged:** a bundle is not an offline mode switch.

## Licensing

The game sources in a bundle come from arcprize.org, downloaded by whoever exported the bundle. **ARC publishes no license for them.** A bundle is for your own environments: never commit, publish or share it. The manifest carries `LICENSE_NOTICE` (`src/bundle.js`), and export and import print it. `.gitignore` ignores `*.arcbundle` anywhere in the checkout.

## Build (on a machine with network)

```bash
node scripts/bundle.mjs export [/abs/path/name.arcbundle]
```

- **Output:** must end in `.arcbundle` and must not exist (`BUNDLE_OUT_INVALID`). A relative path is resolved against the cwd. Default: `<checkout>/bundles/code-arc-<UTC yyyymmdd-HHMMSS>.arcbundle` (`bundles/` is created 0700; its files are gitignored).
- **Host:** the bundle's wheels are for the exporting Python, so export on a host matching the offline one: same OS, CPU architecture, Python minor version and libc family.
- **API key:** the key saved in `$CONDUCTOR_PLUGIN_DATA_DIR/secrets.json` when that variable is set (absolute), otherwise the toolkit's anonymous key. The CLI says which.
- **What it does** (`exportBundle` in `src/bundleExport.js`), in a private scratch dir:
  1. fetches and verifies the pinned pip zipapp;
  2. finds a Python (`findPython`, the bootstrap's candidates) and probes its target;
  3. `pip download --isolated --only-binary=:all: --no-deps -r requirements.txt` (the file is the full frozen set);
  4. builds a scratch venv and installs from the staged files only, with the same `bundleInstallArgs` the boot uses (a self-test that the bundle installs offline);
  5. runs `sidecar/bundle_games.py` in that venv: a NORMAL-mode `Arcade` downloads every listed game. **Each game's `make()` loads and runs it once (its first reset) on the export host.** The exporter's absolute `local_dir` is removed from each `metadata.json`;
  6. writes the manifest, runs `verifyBundle` on the stage, packs it, and links the archive into place.
- **Output printed:** the path, the **bundle id** (sha256 of `manifest.json`), the target, the game count and the license notice.

## Move

Copy the `.arcbundle` file to the offline host. Carry the bundle id over a separate channel (a message, a note) so import can check it.

## Install (on the offline host)

Either import it (stop the plugin first):

```bash
CONDUCTOR_PLUGIN_DATA_DIR=/abs/data/dir node scripts/bundle.mjs import /path/name.arcbundle --expect-sha256 <bundle id> [--replace]
```

- Installs into `<data dir>/bundle/` (`importBundle` in `src/bundleImport.js`). Without `--replace` an existing bundle is refused (`BUNDLE_EXISTS`).
- `--expect-sha256 <id>` refuses any archive whose manifest isn't the one you expect (`BUNDLE_ID_MISMATCH`), before anything is extracted. Without it, the bundle is only as authentic as the way you carried it.
- If `CODE_ARC_BUNDLE` is set, import warns that it shadows the imported bundle.

Or extract it yourself (`tar -xzf name.arcbundle -C /abs/dir`) and set `CODE_ARC_BUNDLE=/abs/dir` in the plugin's environment. Nothing else may be in that directory. **Prefer `import`:** only `scripts/bundle.mjs import` applies the archive's entry-type checks while extracting. System `tar` will create whatever a hostile archive holds (symlinks, FIFOs, devices); the boot verification still rejects such a directory (`BUNDLE_INVALID`), but the extraction itself is unchecked.

Then restart the plugin. `node scripts/setup.mjs` honours a bundle the same way (it reads `CODE_ARC_BUNDLE`, and the data-dir slot when `CONDUCTOR_PLUGIN_DATA_DIR` is set).

## Which bundle is used

| Order | Location | Rules |
|---|---|---|
| 1 | `CODE_ARC_BUNDLE` | absolute path to an extracted bundle dir (a relative value stops the backend at start); realpath'd; never written |
| 2 | `<data dir>/bundle/` | filled by `import` or by hand; must be a real directory, not a symlink |
| 3 | neither | the web, as without this feature |

- When both 1 and 2 exist, 1 wins; status reports `bundle.shadowed` = the data-dir path, and the backend logs it once.
- **An invalid winning bundle is a failed state, never a fall back** to the next location or to the web.
- A bundle inside `<data dir>/toolkit/` is refused (`BUNDLE_INVALID`): the toolkit writes there.

## Boot

`createBootstrap` (`src/bootstrap.js`), phase `bundle` (state `checking`):

1. Locate (above), then `verifyBundle`: manifest schema, `requirements_sha256` = this checkout's, wheels one-to-one with the pins, no unexpected file or directory, no symlink or special file, every file's size and sha256.
   - Every file it reads goes through `openRegularFile` (`src/bundle.js`): `lstat` must say regular file before any open, the open is `O_NOFOLLOW|O_NONBLOCK`, and `fstat` re-checks the handle. A FIFO or device (also one swapped in after the check) fails as `BUNDLE_INVALID` instead of blocking.
   - Shutdown never waits on it: `stop()` aborts the verifier (checked between entries and on every hashed chunk) and the bootstrap stops waiting at once, so the state becomes `stopped` even if a filesystem call is wedged.
2. If the venv's stamp already matches `requirements.txt`, it is used as is.
3. Otherwise, before the venv is touched: the bundle's pip must have this checkout's `PIP_PYZ_SHA256` (`BUNDLE_STALE`); `python<target.python>` is tried before the usual candidates; the interpreter's target must equal the bundle's (`BUNDLE_PLATFORM_MISMATCH`).
4. Venv, then `pip install --isolated --no-index --find-links <bundle>/wheels --require-hashes -r <venv>/code-arc-bundle-requirements.txt` with the bundle's pip. The requirements file has one `name==version --hash=sha256:<wheel sha>` line per pin of this checkout. **No phase `download`; nothing is fetched.**
5. Smoke test and stamp, as without a bundle.

The sidecar is configured with `games_dir = <bundle>/games` once the bootstrap is ready.

## What plays where

The sidecar keeps up to three arcades (`sidecar/engine.py`): `bundle` (OFFLINE over `<bundle>/games`: no network, never writes), `normal` (NORMAL over `<data dir>/toolkit/environment_files`, as without a bundle) and `online`.

| Game | Network | `online:false` (local) | `online:true` |
|---|---|---|---|
| in the bundle (exact id or base id) | up or down | `bundle` arcade, no request sent | `online` arcade as today; down → `NETWORK_ERROR` |
| not in the bundle | up | listed (`source: "web"`); `normal` arcade, downloads into `toolkit/` as today | `online` arcade as today |
| not in the bundle | down | not listed → `GAME_UNKNOWN`, with a `detail` saying the web game list could not be fetched | `NETWORK_ERROR`, `detail` saying the web game list could not be fetched |

- **`list_games`** returns the bundle's games first (`source: "bundle"`), then the web's games (`source: "web"`) when the `normal` arcade loads them within `WEB_LIST_WAIT_S` (`sidecar/engine.py`); ids already in the bundle aren't repeated. A failed or slow web list is a logged degradation, not a refusal; the web list keeps loading in the background and a later call includes it. Without a bundle, a failed list is still a refusal.
- The sidecar's `list_games` reply carries `web_unavailable: {code, detail}` when the web's games are missing (`code` is the refusal the web list failed with, or `WEB_LIST_LOADING`); `start_session` uses it for the two "not in the bundle, network down" cells above.

## Status and the viewer

- `GET api/status` → `toolkit.source`: `web`, `bundle`, or `null` (not decided yet); `toolkit.bundle`: `null`, or `{location, path, id, created_at, target, toolkit, games, shadowed}` (`bundleSummary` in `src/bundle.js`). For a rejected bundle, `id` is `null` and only `location`, `path` and `shadowed` are set.
- The viewer's header says `Toolkit and local games: bundle <first 12 of id> (<n> games)` (tooltip: path, created time, target) or `Toolkit and games: web`. A failed state with a `BUNDLE_*` code shows the banner **Bundle rejected** with the detail and the fix.

## Failures

| Code | When | Fix shown |
|---|---|---|
| `BUNDLE_INVALID` | malformed manifest or archive; path outside the allowlist; unexpected, missing or special file; a limit exceeded; a symlinked slot; a bundle inside `<data dir>/toolkit/`; `CODE_ARC_BUNDLE` unreadable | re-export, or re-import with `node scripts/bundle.mjs import` |
| `BUNDLE_HASH_MISMATCH` | a file's size or sha256 differs from the manifest | re-import from the original archive (`import <archive> --replace`), or remove it to use the web |
| `BUNDLE_STALE` | exported for another `requirements.txt`, or its pip isn't this checkout's pinned pip | export a new bundle from this checkout |
| `BUNDLE_PLATFORM_MISMATCH` | the host interpreter's target differs from the bundle's | export on a matching machine, or install the bundle's Python version |
| `BUNDLE_EXISTS` | `import` with a bundle already installed | `--replace` (plugin stopped) |
| `BUNDLE_ID_MISMATCH` | `import --expect-sha256` with a different bundle | import the bundle you expect |
| `BUNDLE_OUT_INVALID` | export output not ending in `.arcbundle`, relative, or existing | pick a new `.arcbundle` path |
| `BUNDLE_EXPORT_FAILED` | export failed (download, a pin without a wheel, a game that would not download) | see the detail |

At boot, a `BUNDLE_*` failure is the toolkit's `failed` state: `start_session` and `list_games` refuse `TOOLKIT_UNAVAILABLE` with the detail and fix. The CLI prints `CODE: message`, then `Fix: …`, and exits 1 (2 on a usage error).

## Format

```
manifest.json                      first entry of the archive
pip/pip-<version>.pyz
wheels/<name>-<version>-<tags>.whl one per requirements.txt pin
games/<base>/<version>/metadata.json
games/<base>/<version>/<class>.py
```

- **Archive:** gzip of POSIX ustar (`src/tar.js`), regular files and directories only. A file path that doesn't fit ustar's name/prefix fields (for example manylinux wheel names over 100 bytes) is carried by one pax extended header (`x`) holding exactly one `path` record, at most one 512-byte block, directly before that regular file; archives whose paths all fit carry no pax header. The reader rejects every other entry type (links, devices, FIFOs, pax global and GNU headers), any other pax key, more than one record, a malformed length, an oversized pax header, a pax header not followed by a regular file, any link name, non-ustar magic, base-256 sizes, bad checksums, NUL or non-ASCII in names, and truncation. Pax paths pass the same path allowlist as ustar ones. `tar -tzf` lists it.
- **Manifest** (`parseManifest` in `src/bundle.js`, strict: unknown keys refused): `format` (`BUNDLE_FORMAT`), `format_version` (`BUNDLE_FORMAT_VERSION`; unchanged by pax use in the archive), `notice` (= `LICENSE_NOTICE`), `created_at`, `target {implementation, python, system, machine, libc}`, `requirements_sha256`, `toolkit {arc_agi, arcengine}`, `pip {version, file}`, `wheels [{file, project, version}]`, `games [{game_id, title, dir}]`, `files [{path, size, sha256}]`.
- **Paths** (`validateBundlePath`): `[A-Za-z0-9._+-]` segments joined by `/`; no `.`/`..`; `pip/*.pyz` and `wheels/*.whl` at depth 2; `games/…/metadata.json` or `games/…/*.py` at depth 3–4; no case-insensitive duplicates; no file under another file.
- **Bounds:** `BUNDLE_LIMITS` in `src/bundle.js` (manifest size, file count, per-file size, total size, archive size, compression ratio, path length and depth). Import checks the ratio and the total on every decompressed chunk.
- **Bundle id:** sha256 of the `manifest.json` bytes. Every file's sha256 is in the manifest, so the id covers the whole bundle.

## Security and trust

- **Import treats the archive as hostile.** The manifest must come first; each entry must be listed with the same size, is written with `wx`/0600 into a private staging dir (`<data dir>/.bundle-staging-<rand>`, 0700, same filesystem) while it is hashed, and is never given the archive's modes or turned into a link. The staging dir then passes `verifyBundle` and is renamed into place; `--replace` swaps through `.bundle-old-<rand>` with a rollback. Any failure removes staging and leaves the slot as it was; a crashed import's leftovers are swept by the next one. Run one import at a time per data dir.
- **Every boot re-verifies** the bundle before pip runs and before the sidecar is told its games dir; pip re-checks every wheel against hashes built from this checkout's pins.
- **Game code runs.** The bundle's `.py` files are executed in the sidecar as your user, the same trust as games the toolkit downloads (see the README's security notes). A hash proves the files are what the exporter recorded, not that they are benign: import only bundles you exported, or from someone you trust as much as arcprize.org.

## Limitations

- One target per bundle. An offline host whose glibc is older than the wheels need fails as `INSTALL_FAILED`, not `BUNDLE_PLATFORM_MISMATCH`.
- The game set is frozen at export; re-export to pick up new games or versions.
- Stop the plugin before `import --replace`; a running backend keeps using the files it verified at boot.
- `requirements.txt` changes make every existing bundle `BUNDLE_STALE`.
