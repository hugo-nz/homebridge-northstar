import { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { PolestarPlatform } from './platform';

/**
 * Plugin entry point.
 *
 * Homebridge calls this function with its API object when loading the plugin.
 */
export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PolestarPlatform);
};
