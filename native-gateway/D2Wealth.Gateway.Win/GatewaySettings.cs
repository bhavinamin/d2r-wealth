using System.Text.Json.Serialization;

namespace D2Wealth.Gateway.Win;

internal sealed class GatewaySettings
{
    [JsonPropertyName("host")]
    public string Host { get; set; } = "127.0.0.1";

    [JsonPropertyName("port")]
    public int Port { get; set; } = 3187;

    [JsonPropertyName("saveDir")]
    public string SaveDir { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "Saved Games",
        "Diablo II Resurrected",
        "mods",
        "D2RMM_SOLO");

    [JsonPropertyName("autoStart")]
    public bool AutoStart { get; set; }

    [JsonPropertyName("dashboardUrl")]
    public string DashboardUrl { get; set; } = "https://d2r.bjav.io";

    [JsonPropertyName("backendUrl")]
    public string BackendUrl { get; set; } = "https://d2r.bjav.io";

    [JsonPropertyName("accountId")]
    public string AccountId { get; set; } = string.Empty;

    [JsonPropertyName("clientId")]
    public string ClientId { get; set; } = Environment.MachineName.ToLowerInvariant();

    [JsonPropertyName("syncToken")]
    public string SyncToken { get; set; } = string.Empty;
}
