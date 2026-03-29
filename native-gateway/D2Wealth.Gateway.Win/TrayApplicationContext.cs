using System.Drawing;

namespace D2Wealth.Gateway.Win;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly GatewayLogger _logger;
    private readonly SettingsStore _settingsStore;
    private readonly GatewayProcessManager _processManager;
    private readonly GatewayApiClient _apiClient;
    private readonly NotifyIcon _notifyIcon;
    private readonly SettingsForm _settingsForm;
    private readonly System.Windows.Forms.Timer _pollTimer;

    private GatewaySettings _settings;

    public TrayApplicationContext(GatewayLogger logger, SettingsStore settingsStore)
    {
        _logger = logger;
        _settingsStore = settingsStore;
        _settings = _settingsStore.Load();
        _processManager = new GatewayProcessManager(_settingsStore, _logger);
        _apiClient = new GatewayApiClient(_settingsStore);

        _notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "D2 Wealth Gateway",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _notifyIcon.DoubleClick += async (_, _) => await ShowSettingsAsync();

        _settingsForm = new SettingsForm();
        _settingsForm.SaveRequested += SaveSettingsAsync;
        _settingsForm.PairRequested += PairGatewayAsync;
        _settingsForm.DisconnectRequested += DisconnectGatewayAsync;
        _settingsForm.FormClosing += (_, args) =>
        {
            args.Cancel = true;
            _settingsForm.Hide();
        };

        _pollTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        _pollTimer.Tick += async (_, _) => await RefreshStatusAsync();

        _ = InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            _processManager.ApplyAutoStart(_settings.AutoStart);
            _processManager.Start();
            _pollTimer.Start();
            await RefreshStatusAsync();
            await ShowSettingsAsync();
        }
        catch (Exception error)
        {
            _logger.Error("Tray initialization failed.", error);
            MessageBox.Show(error.Message, "D2 Wealth Gateway", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Settings", null, async (_, _) => await ShowSettingsAsync());
        menu.Items.Add("Restart Gateway", null, async (_, _) =>
        {
            await _processManager.RestartAsync();
            await RefreshStatusAsync();
        });
        menu.Items.Add("Exit", null, async (_, _) => await ExitAsync());
        return menu;
    }

    private async Task ShowSettingsAsync()
    {
        var health = await _apiClient.LoadHealthAsync(_settings);
        _settingsForm.ApplySettings(_settings, health);
        _settingsForm.Show();
        _settingsForm.BringToFront();
        _settingsForm.Activate();
    }

    private async Task SaveSettingsAsync()
    {
        _settingsForm.SetBusyState(true, "Saving settings...");
        try
        {
            _logger.Info("Saving gateway settings from tray UI.");
            var health = await PersistFormSettingsAsync();
            _settingsForm.ApplySettings(_settings, health);
        }
        finally
        {
            _settingsForm.SetBusyState(false);
        }
    }

    private async Task PairGatewayAsync()
    {
        _settingsForm.SetBusyState(true, "Opening browser for Discord sign-in...");
        try
        {
            _logger.Info("Persisting tray settings before Discord pairing.");
            var savedHealth = await PersistFormSettingsAsync();
            _settingsForm.ApplySettings(_settings, savedHealth);
            if (savedHealth?.SaveValidation?.Valid != true)
            {
                return;
            }

            _logger.Info("Starting Discord pairing from tray UI.");
            await _apiClient.PairGatewayAsync(_settings, status => _settingsForm.SetBusyState(true, status));
            _settingsStore.Save(_settings);
            await _processManager.RestartAsync();
            var health = await _apiClient.WaitForHealthyStateAsync(
                _settings,
                status => !string.IsNullOrWhiteSpace(status.SyncToken) && (status.LastBackendSyncAt is not null || status.LastBackendSyncError is not null));
            _settingsForm.ApplySettings(_settings, health);
        }
        finally
        {
            _settingsForm.SetBusyState(false);
        }
    }

    private async Task DisconnectGatewayAsync()
    {
        _settingsForm.SetBusyState(true, "Disconnecting gateway...");
        try
        {
            _logger.Info("Disconnecting gateway from tray UI.");
            await _apiClient.DisconnectGatewayAsync(_settings);
            await _processManager.RestartAsync();
            var health = await _apiClient.LoadHealthAsync(_settings);
            _settingsForm.ApplySettings(_settings, health);
        }
        finally
        {
            _settingsForm.SetBusyState(false);
        }
    }

    private async Task RefreshStatusAsync()
    {
        var health = await _apiClient.LoadHealthAsync(_settings);
        _settingsForm.ApplySettings(_settings, health);
        var lifecycle = GatewayStatusPresentation.LifecycleLabel(health);
        _notifyIcon.Text = $"D2 Wealth Gateway - {lifecycle}";
    }

    private async Task<GatewayHealth?> PersistFormSettingsAsync()
    {
        _settings = _settingsForm.CollectSettings(_settings);
        _settingsStore.Save(_settings);
        _processManager.ApplyAutoStart(_settings.AutoStart);
        _processManager.Start();
        return await _apiClient.SaveGatewaySettingsAsync(_settings);
    }

    private async Task ExitAsync()
    {
        _pollTimer.Stop();
        _notifyIcon.Visible = false;
        await _processManager.StopAsync();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _pollTimer.Dispose();
            _notifyIcon.Dispose();
            _settingsForm.Dispose();
        }

        base.Dispose(disposing);
    }
}
