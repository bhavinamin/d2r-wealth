import { GatewayService } from "./service.mjs";
import { readGatewaySettings, writeGatewaySettings } from "./settings.mjs";

const baseSettings = readGatewaySettings();
const cliSettings = {
  ...baseSettings,
  host: process.env.D2_GATEWAY_HOST ?? baseSettings.host,
  port: process.env.D2_GATEWAY_PORT ?? baseSettings.port,
  saveDir: process.env.D2_SAVE_DIR ?? process.argv[2] ?? baseSettings.saveDir,
};

const persisted = writeGatewaySettings(cliSettings);
const service = new GatewayService({ settings: persisted });

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
