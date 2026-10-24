# Building JellyShell

JellyShell has three clients built from this repo: the **Xbox app** (UWP, `shell/XboxShell`), the **Android TV + phone app**
(`android/`) and the **web UI** (`web/`, bundled into both and served by the page server). None of them contains a server
address: a build either gets optional defaults from your CI settings, or asks on first launch.

## Xbox app

### Build on GitHub Actions (a fork, no Windows machine needed)
`.github/workflows/build.yml` runs on every push to `shell/**` on `main`, or by hand (Actions → build-shell → Run workflow).
It builds `web/dist`, bundles it into the package as the offline UI, and uploads the artifact `jellyshell-x64`
(`.msix` plus the `Dependencies/x64/*.appx` the console needs).

Repository **secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Needed | What |
|---|---|---|
| `SIGNING_PFX_B64` | recommended | base64 of a code-signing `.pfx`. Without it each run signs with a throwaway cert, which installs fine but can't update the previous build in place (uninstall first). |
| `SIGNING_PFX_PASSWORD` | with the pfx | its password |
| `JELLYSHELL_MEDIA_URL` | optional | page server the app tries first, e.g. `http://192.168.1.10:8097/` |
| `JELLYSHELL_PUBLIC_URL` | optional | public https URL of the same page server (tried second), e.g. `https://media.example.com/jellyshell/` |
| `JELLYSHELL_DASH_URL` | optional | Dash page server (optional TV dashboard), e.g. `http://192.168.1.10:8098/` |

The three `JELLYSHELL_*_URL` values may also be repository **variables** instead (secrets win). Without any of them the app
starts on its bundled UI and the first-run screen asks for the Jellyfin server and, optionally, the JellyShell server;
Settings → JellyShell server changes it later.

Repository **variables** (optional):

| Variable | What |
|---|---|
| `SIDELOAD_IDENTITY` | package Identity Name, default `JellyShell.Sideload` (from `Package.appxmanifest`). Set this to the Name of an existing install to keep upgrading it in place. |
| `SIDELOAD_PHONE_PRODUCT_ID` | overrides `mp:PhoneIdentity` (a GUID). Only needed together with `SIDELOAD_IDENTITY` when an existing install used a different one. |
| `VERSION_OFFSET` | added to the CI run number in every version (Xbox sideload, Store, Android `versionCode`). Set it when you move to a new repo so new builds still install over older ones. |

**Signing certificate.** The certificate's subject must equal the manifest's `Publisher` (`CN=JellyShellDev`; the workflow
checks it). Make one once, on any Windows PowerShell, and keep the `.pfx` backed up (a new key = no in-place updates):

```powershell
$c = New-SelfSignedCertificate -Type Custom -Subject "CN=JellyShellDev" -KeyUsage DigitalSignature `
  -FriendlyName "JellyShell sideload" -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") -NotAfter (Get-Date).AddYears(10)
$pw = Read-Host -AsSecureString "pfx password"
Export-PfxCertificate -Cert $c -FilePath JellyShell.pfx -Password $pw
[Convert]::ToBase64String([IO.File]::ReadAllBytes("JellyShell.pfx")) | Set-Clipboard   # paste as SIGNING_PFX_B64
```

On Linux/macOS: `base64 -w0 JellyShell.pfx` (macOS: `base64 -i JellyShell.pfx`) gives the secret value.
If you change `Publisher` in the manifest, make the certificate with the same subject.

Microsoft Store builds use `build-store.yml` and their own identity variables: see docs/store-release.md.

### Build locally (Visual Studio)
Windows 10/11 with Visual Studio 2022 or newer, workload "Universal Windows Platform development" (Windows SDK 10.0.26100)
and Node.js 22.
1. Bundle the web UI: `cd web && npm ci && npm run build`, then copy `web\dist\*` into `shell\XboxShell\ui\`
   (optional: without it the app needs a page server and shows an error when none is configured).
2. Open `shell\XboxShell\XboxShell.csproj`, pick `Release | x64`, and either deploy to the console directly
   (Debug → Remote Machine, the Xbox's IP) or Project → Publish → Create App Packages → Sideloading, signed with your pfx.
3. Optional defaults: set the environment variables `JELLYSHELL_MEDIA_URL` / `JELLYSHELL_PUBLIC_URL` / `JELLYSHELL_DASH_URL`
   before starting Visual Studio, or build from a Developer prompt:
   `msbuild shell\XboxShell\XboxShell.csproj /p:Configuration=Release /p:Platform=x64 /p:JellyShellMediaUrl=http://192.168.1.10:8097/`.
   They are written to `obj\...\BuildDefaults.g.cs` (never committed); the build log prints `BuildDefaults: media=... `.

### Sideload on an Xbox in Dev Mode
1. Activate Developer Mode on the console (Microsoft's Dev Mode Activation app, one-time developer account fee) and
   restart into Dev Home.
2. In Dev Home, enable **Remote Access** and set a user name/password. Open the shown address,
   `https://<xbox-ip>:11443`, in a browser on the same network (accept the self-signed certificate).
3. Device Portal → **Home** → **Add** (Apps): pick the `.msix` from the artifact, then on the next page add the dependency
   packages from `Dependencies/x64/` (skip `*.Desktop.*`), and Start. Repeat with a newer build to upgrade (same identity
   and certificate required; otherwise uninstall first).
4. Launch JellyShell from Dev Home or the collection. The console must stay in Dev Mode to run sideloaded apps.

## Android TV + phone app

### Build locally
Needs JDK 17 or newer (21 works) and the Android SDK (platform 35, build-tools 35; Android Studio installs both, or use
the command-line tools with `ANDROID_HOME` / `local.properties` `sdk.dir=`).

```sh
cd android
./gradlew assembleTvRelease assembleMobileRelease \
  -PJELLYSHELL_DEFAULT_URL=https://media.example.com/jellyshell/   # optional
# → app/build/outputs/apk/tv/release/app-tv-release.apk (Android TV / Google TV)
#   app/build/outputs/apk/mobile/release/app-mobile-release.apk (phones/tablets)
```

Options (gradle `-P` property or environment variable of the same name):
- `JELLYSHELL_DEFAULT_URL`: page-server URL the app opens until the user sets another one. Empty (default) = the app asks
  on first launch. Users change it later with Back 5× within 2 s (TV) or the long-press icon shortcut "Server address" (phone).
- `JELLYSHELL_APP_ID`: applicationId base, default `app.jellyshell`; the TV app is `<base>.tv`, the phone app
  `<base>.mobile`. Keep it unchanged once people have installed your build: Android only updates an app with the same id
  and the same signing key.

Signing: with `android/keystore.properties` (gitignored) the release APKs use your key; without it they are signed with the
local debug key (fine for trying it out, but they won't update over a release-signed install):

```properties
storeFile=/absolute/path/to/release.jks
storePassword=...
keyAlias=jellyshell
keyPassword=...
```

Make a keystore once and back it up (a lost key means users must uninstall to update):

```sh
keytool -genkeypair -v -keystore release.jks -alias jellyshell -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype PKCS12 -dname "CN=JellyShell"
```

(PKCS12 uses one password for the store and the key, which is what CI expects.)

### Build on GitHub Actions
`.github/workflows/build-android.yml` runs on pushes to `android/**` on `main` or by hand, and uploads
`jellyshell-tv-apk` and `jellyshell-android-apk`.
- Secrets `ANDROID_KEYSTORE_B64` (`base64 -w0 release.jks`) and `ANDROID_KEYSTORE_PASSWORD` (alias must be `jellyshell`).
  Without them the APKs are debug-signed and the run shows a warning.
- Optional: variable `JELLYSHELL_APP_ID`, and `JELLYSHELL_DEFAULT_URL` as a secret or variable.

Install: `adb install -r app-tv-release.apk` (TV with USB/network debugging on), or put the APKs where the device can
download them (the page server serves files from its data dir's `apk/` folder at `/tv.apk` and `/android.apk`).
