using System.Text.Json.Serialization;

namespace D2Wealth.Gateway.Win;

internal sealed class GatewayHealth
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("host")]
    public string Host { get; set; } = "127.0.0.1";

    [JsonPropertyName("port")]
    public int Port { get; set; }

    [JsonPropertyName("saveDir")]
    public string SaveDir { get; set; } = string.Empty;

    [JsonPropertyName("syncToken")]
    public string SyncToken { get; set; } = string.Empty;

    [JsonPropertyName("files")]
    public List<GatewayTrackedFile> Files { get; set; } = [];

    [JsonPropertyName("lastBackendSyncAt")]
    public string? LastBackendSyncAt { get; set; }

    [JsonPropertyName("lastBackendSyncError")]
    public string? LastBackendSyncError { get; set; }

    [JsonPropertyName("lastSuccessfulAccountUpdateAt")]
    public string? LastSuccessfulAccountUpdateAt { get; set; }

    [JsonPropertyName("saveValidation")]
    public SaveValidationStatus? SaveValidation { get; set; }

    [JsonPropertyName("statusSummary")]
    public GatewayStatusSummary? StatusSummary { get; set; }
}

internal sealed class SaveValidationStatus
{
    [JsonPropertyName("valid")]
    public bool Valid { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("characterCount")]
    public int CharacterCount { get; set; }

    [JsonPropertyName("checkedAt")]
    public string? CheckedAt { get; set; }

    [JsonPropertyName("nextRetryAt")]
    public string? NextRetryAt { get; set; }
}

internal sealed class GatewayStatusSummary
{
    [JsonPropertyName("save")]
    public GatewayStatusEntry? Save { get; set; }

    [JsonPropertyName("pairing")]
    public GatewayStatusEntry? Pairing { get; set; }

    [JsonPropertyName("sync")]
    public GatewayStatusEntry? Sync { get; set; }

    [JsonPropertyName("lastError")]
    public GatewayStatusError? LastError { get; set; }

    [JsonPropertyName("dashboardFreshness")]
    public GatewayStatusEntry? DashboardFreshness { get; set; }
}

internal sealed class GatewayStatusEntry
{
    [JsonPropertyName("state")]
    public string State { get; set; } = string.Empty;

    [JsonPropertyName("label")]
    public string Label { get; set; } = string.Empty;

    [JsonPropertyName("detail")]
    public string Detail { get; set; } = string.Empty;
}

internal sealed class GatewayStatusError
{
    [JsonPropertyName("scope")]
    public string Scope { get; set; } = string.Empty;

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("occurredAt")]
    public string? OccurredAt { get; set; }
}

internal sealed class PairingSessionResponse
{
    [JsonPropertyName("pairingId")]
    public string PairingId { get; set; } = string.Empty;

    [JsonPropertyName("pairingSecret")]
    public string PairingSecret { get; set; } = string.Empty;

    [JsonPropertyName("pairingUrl")]
    public string PairingUrl { get; set; } = string.Empty;
}

internal sealed class PairingClaimResponse
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("gatewayToken")]
    public string GatewayToken { get; set; } = string.Empty;
}

internal sealed class GatewayTrackedFile
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("size")]
    public long Size { get; set; }

    [JsonPropertyName("modifiedAt")]
    public string? ModifiedAt { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;
}
