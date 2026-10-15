# M-Digital Releases

Public downloads for the M-Digital product family.

Source code is private and lives in the `teminali` org:
- [teminali/m-digital-desktop](https://github.com/teminali/m-digital-desktop) — accounting & business management (Electron desktop)
- [teminali/m-digital-pos](https://github.com/teminali/m-digital-pos) — standalone POS terminal (Electron desktop)
- [teminali/m-digital](https://github.com/teminali/m-digital) — Flutter mobile app (Android APK / AAB)

Each release on this repo bundles binaries from one of the three source
repos. To avoid collision when the same tag is pushed to different
source repos, this repo uses product-prefixed tag refs: desktop
releases land at refs like `desktop-v0.0.1`, POS releases at
`pos-v0.0.1`, and mobile at `mobile-v0.0.1`. The source repos use
plain `v*` tags; the redirect to a prefixed tag is wired in the
publish step of each source repo's release workflow.

| Source repo | What ships |
|-------------|------------|
| [m-digital-desktop](https://github.com/teminali/m-digital-desktop) | macOS DMG/ZIP (arm64 + x64), Windows NSIS x64, Linux AppImage + deb x64, `SHA256SUMS.txt` |
| [m-digital-pos](https://github.com/teminali/m-digital-pos) | macOS DMG/ZIP, Windows NSIS, Linux AppImage + deb, auto-update feed (`latest*.yml`, `*.blockmap`), `SHA256SUMS.txt` |
| [m-digital](https://github.com/teminali/m-digital) | Android `app-release.apk` + `app-release.aab`, `SHA256SUMS.txt` |

Until each product publishes its first release here, the corresponding
section has no download links.

## Verifying a download

Each release ships a `SHA256SUMS.txt`. Verify before installing:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

(Or pick the single line relevant to the file you downloaded.)

## Latest release

The list of GitHub releases is the canonical index:

https://github.com/teminali/mdigital-releases/releases

## Older POS releases

Releases published before 2026-10-15 for the POS product live at
[teminali/m-digital-pos-releases](https://github.com/teminali/m-digital-pos-releases),
which is now frozen. New POS releases will only land here.
