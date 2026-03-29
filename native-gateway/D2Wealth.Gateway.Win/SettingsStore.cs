using System.Text.Json;

namespace D2Wealth.Gateway.Win;

internal sealed class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    public string RootPath { get; }
    public string SettingsPath { get; }

    public SettingsStore(string? settingsPath = null)
    {
        SettingsPath = string.IsNullOrWhiteSpace(settingsPath)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "D2 Wealth Gateway",
                "settings.json")
            : Path.GetFullPath(settingsPath);
        RootPath = Path.GetDirectoryName(SettingsPath)
            ?? throw new InvalidOperationException("Settings path must include a parent directory.");
        Directory.CreateDirectory(RootPath);
    }

    public GatewaySettings Load()
    {
        if (!File.Exists(SettingsPath))
        {
            var created = new GatewaySettings();
            Save(created);
            return created;
        }

        try
        {
            var json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<GatewaySettings>(json, JsonOptions) ?? new GatewaySettings();
        }
        catch
        {
            return new GatewaySettings();
        }
    }

    public void Save(GatewaySettings settings)
    {
        File.WriteAllText(SettingsPath, JsonSerializer.Serialize(settings, JsonOptions));
    }
}
