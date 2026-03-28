import { GatewayService } from "./service.mjs";
import { DEFAULT_SETTINGS_PATH, readGatewaySettings, writeGatewaySettings } from "./settings.mjs";

const settingsPath = process.env.D2_GATEWAY_SETTINGS_PATH ?? DEFAULT_SETTINGS_PATH;
const baseSettings = readGatewaySettings(settingsPath);
const cliSettings = {
  ...baseSettings,
  host: process.env.D2_GATEWAY_HOST ?? baseSettings.host,
  port: process.env.D2_GATEWAY_PORT ?? baseSettings.port,
  saveDir: process.env.D2_SAVE_DIR ?? process.argv[2] ?? baseSettings.saveDir,
};

const persisted = writeGatewaySettings(cliSettings, settingsPath);
const service = new GatewayService({ settingsPath, settings: persisted });

try {
  const status = await service.start();
  console.log(`D2 gateway listening on http://${status.host}:${status.port}`);
  console.log(`Watching ${status.saveDir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await service.stop();
    process.exit(0);
  });
}
