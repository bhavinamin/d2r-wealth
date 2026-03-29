namespace D2Wealth.Gateway.Win;

static class Program
{
    [STAThread]
    static async Task Main(string[] args)
    {
        var (settingsPath, commandArgs) = ParseSettingsPath(args);
        var settingsStore = new SettingsStore(settingsPath);
        using var logger = new GatewayLogger(settingsStore.RootPath);

        try
        {
            if (commandArgs.Any(arg => string.Equals(arg, "--tray", StringComparison.OrdinalIgnoreCase) || string.Equals(arg, "tray", StringComparison.OrdinalIgnoreCase)))
            {
                logger.Info("Starting tray mode.");
                ApplicationConfiguration.Initialize();
                Application.Run(new TrayApplicationContext(logger, settingsStore));
                return;
            }

            var host = new ConsoleGatewayHost(logger, settingsStore);
            await host.RunAsync(commandArgs);
        }
        catch (Exception error)
        {
            logger.Error("Gateway console run failed.", error);
            Environment.ExitCode = 1;
        }
    }

    private static (string? SettingsPath, string[] RemainingArgs) ParseSettingsPath(string[] args)
    {
        var remaining = new List<string>();
        string? settingsPath = null;

        for (var index = 0; index < args.Length; index++)
        {
            if (string.Equals(args[index], "--settings-path", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 >= args.Length)
                {
                    throw new InvalidOperationException("Missing value for '--settings-path'.");
                }

                settingsPath = args[++index];
                continue;
            }

            remaining.Add(args[index]);
        }

        return (settingsPath, remaining.ToArray());
    }
}
