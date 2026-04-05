export const PLUGIN_NAME = 'homebridge-northstar';
export const PLATFORM_NAME = 'Northstar';

// Polestar OIDC / OAuth2 constants (from pypolestar)
export const OIDC_PROVIDER_BASE_URL = 'https://polestarid.eu.polestar.com';
export const OIDC_CLIENT_ID = 'l3oopkc_10';
export const OIDC_REDIRECT_URI = 'https://www.polestar.com/sign-in-callback';
export const OIDC_SCOPE = 'openid profile email customer:attributes';

// GraphQL API endpoint
export const API_URL = 'https://pc-api.polestar.com/eu-north-1/mystar-v2/';

// Defaults
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;
export const TOKEN_REFRESH_WINDOW_SECONDS = 300;
export const REQUEST_TIMEOUT_MS = 30_000;
export const LOW_BATTERY_THRESHOLD = 20;
