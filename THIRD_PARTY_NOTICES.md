# Third-party notices

## CDT-Monitor upstream and donor provenance

The planned P7 Web Console UI is derived from the Workers port
[`kfqkfy/cdt-monitor-worker`](https://github.com/kfqkfy/cdt-monitor-worker/tree/75e6962d46791c517d4489227b6f0cf0c5c6a208)
at commit `75e6962d46791c517d4489227b6f0cf0c5c6a208`. That repository's README
describes it as a Workers port of
[`wang4386/CDT-Monitor`](https://github.com/wang4386/CDT-Monitor). The upstream
project provides the MIT license notice reproduced below, with copyright
`(c) 2026 青柠`.

The donor commit has no root `LICENSE` file. Its README's port statement records
the claimed relationship to upstream; it is not a separate license file. The
notice below preserves the upstream MIT attribution for the planned derivative
UI. Retain and review any additional notices present in individual donor files
when those files are imported.

### MIT License

Copyright (c) 2026 青柠

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Derived static assets

The following files are copied from the donor's `static/` directory at the
pinned commit above. The HTML and styles remain substantially as supplied;
only the product label and unsupported-feature/security feedback hooks were
adapted.

| Donor file                     | Role                                              | Notice handling                               |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------- |
| `static/index.html`            | Donor dashboard markup and client code.           | Retain applicable source notices.             |
| `static/tailwind-compiled.css` | Compiled Tailwind CSS v4 stylesheet.              | Embedded Tailwind MIT header retained.        |
| `static/vue.global.prod.js`    | Vue global production bundle.                     | Embedded Vue MIT header retained.             |
| `static/echarts.min.js`        | ECharts browser bundle used by the history chart. | Embedded Apache and bundled notices retained. |
| `static/icon.png`              | Donor favicon.                                    | Copied unchanged from the donor pin.          |
| `static/input.css`             | Tailwind CSS source stylesheet.                   | Copied unchanged from the donor pin.          |

This upstream MIT notice does not replace third-party notices or license terms
carried by the bundled assets.
