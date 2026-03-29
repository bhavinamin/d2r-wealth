namespace D2Wealth.Gateway.Win;

internal static class GatewayStatusPresentation
{
    public static string LifecycleLabel(GatewayHealth? health)
    {
        var syncState = health?.StatusSummary?.Sync?.State;
        return syncState switch
        {
            "synced" => "Connected",
            "pending" => "Connected",
            "syncing" => "Syncing",
            "error" => "Error",
            "blocked" => "Blocked",
            "not-paired" => "Disconnected",
            _ when !string.IsNullOrWhiteSpace(health?.SyncToken) => "Connected",
            _ => "Disconnected",
        };
    }

    public static string LifecycleDetail(GatewayHealth? health)
    {
        if (health?.StatusSummary?.Sync?.Detail is { Length: > 0 } detail)
        {
            return detail;
        }

        if (!string.IsNullOrWhiteSpace(health?.LastBackendSyncError))
        {
            return health.LastBackendSyncError;
        }

        if (!string.IsNullOrWhiteSpace(health?.LastBackendSyncAt))
        {
            return $"Last upload reached the backend at {health.LastBackendSyncAt}.";
        }

        return string.IsNullOrWhiteSpace(health?.SyncToken)
            ? "This PC is not linked yet. Sign in with Discord to connect it."
            : "Pairing is complete and the gateway is waiting for its first successful upload.";
    }

    public static string PairingMessage(GatewayHealth? health, bool hasUnsavedChanges)
    {
        var saveState = health?.StatusSummary?.Save?.State ?? string.Empty;
        var pairingState = health?.StatusSummary?.Pairing?.State ?? string.Empty;
        var syncState = health?.StatusSummary?.Sync?.State ?? string.Empty;

        if (pairingState == "paired" && syncState == "synced")
        {
            return "This PC is linked to your D2 Wealth account and can keep syncing in the background.";
        }

        if (pairingState == "paired")
        {
            return "This PC is linked, but sync still needs to finish cleanly before the dashboard is current.";
        }

        if (hasUnsavedChanges)
        {
            return "Save the Diablo II folder choice first. After that, Discord sign-in can open in your browser.";
        }

        if (saveState != "ready")
        {
            return "Choose a valid Diablo II save folder before starting Discord sign-in for this PC.";
        }

        return "Sign in with Discord in the browser and approve pairing for this PC. The gateway will claim its sync token automatically.";
    }

    public static string ErrorHeadline(GatewayHealth? health)
    {
        var lastError = health?.StatusSummary?.LastError;
        if (lastError is null)
        {
            return "Clear";
        }

        return string.IsNullOrWhiteSpace(lastError.Scope) ? "Error" : lastError.Scope;
    }

    public static string ErrorDetail(GatewayHealth? health)
    {
        var lastError = health?.StatusSummary?.LastError;
        return lastError?.Message ?? "No recent blocking error.";
    }
}
