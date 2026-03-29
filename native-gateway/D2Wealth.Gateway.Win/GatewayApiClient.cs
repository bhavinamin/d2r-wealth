using System.Diagnostics;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace D2Wealth.Gateway.Win;

internal sealed class GatewayApiClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _httpClient = new();
    private readonly SettingsStore _settingsStore;

    public GatewayApiClient(SettingsStore settingsStore)
    {
        _settingsStore = settingsStore;
    }

    private string BaseUrl(GatewaySettings settings) => $"http://{settings.Host}:{settings.Port}";

    public async Task<GatewayHealth?> LoadHealthAsync(GatewaySettings settings, CancellationToken cancellationToken = default)
    {
        try
        {
            return await _httpClient.GetFromJsonAsync<GatewayHealth>($"{BaseUrl(settings)}/health", JsonOptions, cancellationToken);
        }
        catch
        {
            return null;
        }
    }

    public async Task<GatewayHealth?> SaveGatewaySettingsAsync(GatewaySettings settings, CancellationToken cancellationToken = default)
    {
        var response = await _httpClient.PostAsJsonAsync($"{BaseUrl(settings)}/settings", new
        {
            saveDir = settings.SaveDir,
            autoStart = settings.AutoStart,
        }, JsonOptions, cancellationToken);
        response.EnsureSuccessStatusCode();

        return await WaitForHealthyStateAsync(
            settings,
            status => status.SaveDir == settings.SaveDir && status.SaveValidation?.CheckedAt is not null,
            cancellationToken);
    }

    public async Task PairGatewayAsync(GatewaySettings settings, Action<string> statusCallback, CancellationToken cancellationToken = default)
    {
        var pairingResponse = await _httpClient.PostAsJsonAsync($"{settings.BackendUrl.TrimEnd('/')}/api/gateway/pairing-sessions", new
        {
            clientId = settings.ClientId,
        }, JsonOptions, cancellationToken);
        pairingResponse.EnsureSuccessStatusCode();

        var session = await pairingResponse.Content.ReadFromJsonAsync<PairingSessionResponse>(JsonOptions, cancellationToken)
            ?? throw new InvalidOperationException("Pairing start returned no payload.");

        Process.Start(new ProcessStartInfo
        {
            FileName = session.PairingUrl,
            UseShellExecute = true,
        });

        var deadline = DateTimeOffset.UtcNow.AddMinutes(10);
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            statusCallback("Waiting for browser approval...");
            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);

            var claimResponse = await _httpClient.PostAsJsonAsync(
                $"{settings.BackendUrl.TrimEnd('/')}/api/gateway/pairing-sessions/{Uri.EscapeDataString(session.PairingId)}/claim",
                new { pairingSecret = session.PairingSecret },
                JsonOptions,
                cancellationToken);

            if ((int)claimResponse.StatusCode == 202)
            {
                continue;
            }

            claimResponse.EnsureSuccessStatusCode();
            var claim = await claimResponse.Content.ReadFromJsonAsync<PairingClaimResponse>(JsonOptions, cancellationToken)
                ?? throw new InvalidOperationException("Pairing claim returned no payload.");

            settings.SyncToken = claim.GatewayToken;
            _settingsStore.Save(settings);
            return;
        }

        throw new TimeoutException("Gateway pairing timed out.");
    }

    public async Task DisconnectGatewayAsync(GatewaySettings settings, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(settings.SyncToken))
        {
            settings.SyncToken = string.Empty;
            _settingsStore.Save(settings);
            return;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{settings.BackendUrl.TrimEnd('/')}/api/gateway/disconnect")
        {
            Content = new StringContent(JsonSerializer.Serialize(new { clientId = settings.ClientId }), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", settings.SyncToken);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        settings.SyncToken = string.Empty;
        _settingsStore.Save(settings);
    }

    public async Task<GatewayHealth?> WaitForHealthyStateAsync(
        GatewaySettings settings,
        Func<GatewayHealth, bool> predicate,
        CancellationToken cancellationToken = default,
        int timeoutSeconds = 25)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(timeoutSeconds);
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var health = await LoadHealthAsync(settings, cancellationToken);
            if (health is not null && predicate(health))
            {
                return health;
            }

            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
        }

        return await LoadHealthAsync(settings, cancellationToken);
    }
}
