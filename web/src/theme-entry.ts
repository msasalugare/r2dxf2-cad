// Early theme bootstrap: applies the persisted/system theme as soon as this
// module runs, before the main app renders its markup. This replaces the
// former inline `<script>` in index.html, which the CSP (`script-src 'self'`)
// blocked.
import { initTheme } from './theme';

initTheme();
