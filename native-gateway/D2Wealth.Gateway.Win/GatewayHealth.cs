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

    [JsonPropertyName("lastBackendSyncAt")]
    public string? LastBackendSyncAt { get; set; }

    [JsonPropertyName("lastBackendSyncError")]
    public string? LastBackendSyncError { get; set; }

    [JsonPropertyName("saveValidation")]
    public SaveValidationStatus? SaveValidation { get; set; }
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
