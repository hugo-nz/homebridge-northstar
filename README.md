# homebridge-polestar

A [Homebridge](https://homebridge.io) plugin that connects to the Polestar API to expose your Polestar vehicle as a HomeKit accessory.

> **Disclaimer:** This plugin is not affiliated with or endorsed by Polestar. It uses the same reverse-engineered API as the [pypolestar](https://github.com/pypolestar/pypolestar) library.

## Features

Each vehicle in your Polestar account is added as a HomeKit accessory with the following services:

| HomeKit service | Data exposed |
|---|---|
| **Battery** | Battery level (%), charging state, low-battery alert |
| **Outlet** | On = actively charging; OutletInUse = charger connected |
| **Accessory Information** | Manufacturer, model name, VIN, model year |

## Installation

```bash
npm install -g homebridge-polestar
```

Or install via the [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x) by searching for `homebridge-polestar`.

## Configuration

Add the following to the `platforms` array in your Homebridge `config.json`:

```json
{
  "platform": "Polestar",
  "name": "Polestar",
  "email": "your@email.com",
  "password": "your-polestar-password",
  "refreshInterval": 60
}
```

### Config options

| Option | Required | Default | Description |
|---|---|---|---|
| `email` | ✅ | — | Your Polestar account email |
| `password` | ✅ | — | Your Polestar account password |
| `vin` | ❌ | *(all vehicles)* | Filter to a specific VIN |
| `refreshInterval` | ❌ | `60` | How often (seconds) to poll the API |

## Requirements

- Node.js ≥ 18
- Homebridge ≥ 1.3.0
- A Polestar account (same credentials used in the Polestar mobile app)

## Development

```bash
npm install
npm run build     # compile TypeScript → dist/
npm test          # run Jest unit tests
npm run watch     # watch mode
```
