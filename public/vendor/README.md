Vendored third-party browser libraries (no CDN, no network fetch at runtime).

| File | Package | Version | License |
|------|---------|---------|---------|
| `react.production.min.js` | react (UMD build) | 18.3.1 | MIT (`react.LICENSE`) |
| `react-dom.production.min.js` | react-dom (UMD build) | 18.3.1 | MIT (`react-dom.LICENSE`) |
| `babel.min.js` | @babel/standalone | 8.0.4 | MIT (`babel-standalone.LICENSE`) |

React 19 dropped UMD builds, so the frontend pins React 18 — the last major
version with a `<script>`-tag-loadable build. Babel standalone performs JSX
transform in the browser at load time (no build step), matching this
project's zero-build / offline-deployable design.
