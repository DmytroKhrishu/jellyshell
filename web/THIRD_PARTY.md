# Third-party assets

## Lucide icons (`lucide-preact`)

Used for all UI icons (`src/components/icons.tsx`). Only the imported icons are bundled (tree-shaken, inline SVG,
no network/CDN access at runtime).

- Project: https://lucide.dev — https://github.com/lucide-icons/lucide
- Licence: ISC

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING
ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL,
DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE
OR PERFORMANCE OF THIS SOFTWARE.
```

## QR codes (`qrcode-generator`)

Draws the pairing QR code in Settings → Phone remote (`src/components/RemoteDialog.tsx`), as inline SVG, offline.

- Project: https://github.com/kazuhikoarase/qrcode-generator
- Licence: MIT, Copyright (c) 2009 Kazuhiko Arase
