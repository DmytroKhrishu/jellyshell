# JellyShell Privacy Policy

Effective October 29, 2026

## The short version

- JellyShell talks only to servers you choose: your own Jellyfin server and, if you use them, your own Seerr server and
  JellyShell server.
- There is no analytics, no advertising and no third-party tracking.
- Diagnostic logs go to your own server, never to us.
- Your sign-in details stay on your device.

## Who we are

JellyShell is an open-source client for your own Jellyfin media server, for Xbox, Android TV, Android phones and web
browsers, with an optional home dashboard. "We" below means the publisher of the build you installed. JellyShell is an
independent app and is not affiliated with or endorsed by the Jellyfin project. The source code is at
<https://github.com/DmytroKhrishu/jellyshell>.

## What JellyShell connects to

JellyShell does not run any servers that collect your data. It connects only to:

- **Your Jellyfin server**, to sign you in, browse your library, show artwork and play your media.
- **Your Seerr server** (optional), if your server owner has set up media requests.
- **Your JellyShell server** (optional), a self-hosted companion that can host the app's interface, the home dashboard
  and the diagnostic log described below.

These servers are run by you or by whoever invited you to use them. What they store is governed by their owner, not by
us. Some request screens show poster artwork that your Seerr server links from The Movie Database's image service
(image.tmdb.org); loading those images sends your network address to that service, as with any web image.

## What we collect

Nothing. We do not collect, receive, sell or share personal information. The app contains no analytics, advertising,
crash-reporting or tracking software, and it does not build a profile of you.

## Information stored on your device

To keep you signed in, JellyShell stores your server address, your Jellyfin user name and user ID and the access token
your Jellyfin server issues, along with your app preferences (for example audio, subtitle and display settings). This
information stays in the app's local storage on your device. Signing out removes the access token; uninstalling the app
removes all of it. Your password is sent only to your own Jellyfin server and is not stored by the app.

## Diagnostic logs

To help fix playback problems, JellyShell sends short technical log lines (for example app version, device type,
playback events and error messages) to the JellyShell server the app's interface is loaded from, if you use one. These
logs stay on that server. They are never sent to us or to any third party, and access keys are removed from them before
they are written. Without a JellyShell server, no logs leave the device.

## Microsoft and Google

JellyShell for Xbox is distributed through the Microsoft Store. Microsoft may collect information about the console, the
Store and app installs under its own [privacy statement](https://privacy.microsoft.com/privacystatement). We do not
receive any of it beyond the aggregate reports Partner Center gives every publisher. On Android, the system WebView and
the operating system are covered by Google's own privacy policy.

## Children

JellyShell is not directed at children and does not knowingly collect information from anyone. What content is
available depends entirely on the media library and parental controls of your own Jellyfin server.

## Changes

If this policy changes, the updated version will be posted at this address with a new effective date. The full history
of this page is in the repository's commit log.

## Contact

Questions about this policy: open an issue at <https://github.com/DmytroKhrishu/jellyshell/issues>.
