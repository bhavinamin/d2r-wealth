using System.Drawing;

namespace D2Wealth.Gateway.Win;

internal sealed class SettingsForm : Form
{
    private readonly TextBox _saveDirTextBox;
    private readonly Label _lifecycleLabel;
    private readonly Label _saveStatusLabel;
    private readonly Label _pairCopyLabel;
    private readonly Label _syncStatusLabel;
    private readonly Label _pairingStatusLabel;
    private readonly Label _lastErrorStatusLabel;
    private readonly Label _lastUpdateStatusLabel;
    private readonly CheckBox _autoStartCheckbox;
    private readonly Button _saveButton;
    private readonly Button _pairButton;
    private readonly Button _disconnectButton;
    private readonly Button _browseButton;

    private GatewaySettings _appliedSettings = new();
    private GatewayHealth? _lastHealth;
    private bool _saveDirDirty;
    private bool _autoStartDirty;
    private bool _applyingSettings;
    private bool _busy;
    private string? _busyMessage;

    public event Func<Task>? SaveRequested;
    public event Func<Task>? PairRequested;
    public event Func<Task>? DisconnectRequested;

    public SettingsForm()
    {
        Text = "D2 Wealth Gateway";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(560, 470);
        BackColor = Color.FromArgb(20, 17, 15);
        ForeColor = Color.FromArgb(243, 237, 225);

        var titleLabel = new Label
        {
            Text = "D2 Wealth Gateway",
            Left = 18,
            Top = 16,
            Width = 250,
            Font = new Font("Segoe UI", 12, FontStyle.Bold),
        };
        _lifecycleLabel = new Label
        {
            Left = 400,
            Top = 16,
            Width = 142,
            Height = 30,
            TextAlign = ContentAlignment.MiddleCenter,
            BackColor = Color.FromArgb(49, 45, 41),
            ForeColor = Color.FromArgb(243, 237, 225),
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
        };

        var saveTitle = new Label { Text = "Save Folder", Left = 18, Top = 62, Width = 120 };
        _saveDirTextBox = new TextBox { Left = 18, Top = 86, Width = 430 };
        _browseButton = new Button { Text = "Browse", Left = 458, Top = 84, Width = 84, Height = 28 };
        _saveStatusLabel = new Label { Left = 18, Top = 118, Width = 524, Height = 42 };

        var accountTitle = new Label { Text = "Account Link", Left = 18, Top = 168, Width = 120 };
        _pairCopyLabel = new Label { Left = 18, Top = 192, Width = 524, Height = 42 };
        _pairButton = new Button { Text = "Sign in with Discord", Left = 18, Top = 238, Width = 182, Height = 34 };
        _disconnectButton = new Button { Text = "Disconnect", Left = 212, Top = 238, Width = 120, Height = 34 };

        var statusTitle = new Label { Text = "Sync Lifecycle", Left = 18, Top = 286, Width = 140 };
        _syncStatusLabel = new Label { Left = 18, Top = 310, Width = 250, Height = 62 };
        _pairingStatusLabel = new Label { Left = 292, Top = 310, Width = 250, Height = 62 };
        _lastErrorStatusLabel = new Label { Left = 18, Top = 378, Width = 250, Height = 52 };
        _lastUpdateStatusLabel = new Label { Left = 292, Top = 378, Width = 250, Height = 52 };

        _autoStartCheckbox = new CheckBox
        {
            Text = "Start automatically with Windows",
            Left = 18,
            Top = 432,
            Width = 240,
        };
        _saveButton = new Button { Text = "Save Settings", Left = 402, Top = 426, Width = 140, Height = 34 };

        _saveDirTextBox.TextChanged += (_, _) =>
        {
            if (_applyingSettings)
            {
                return;
            }

            _saveDirDirty = true;
            RefreshView();
        };
        _autoStartCheckbox.CheckedChanged += (_, _) =>
        {
            if (_applyingSettings)
            {
                return;
            }

            _autoStartDirty = true;
            RefreshView();
        };
        _browseButton.Click += BrowseButtonOnClick;
        _saveButton.Click += async (_, _) => { if (SaveRequested is not null) await SaveRequested(); };
        _pairButton.Click += async (_, _) => { if (PairRequested is not null) await PairRequested(); };
        _disconnectButton.Click += async (_, _) => { if (DisconnectRequested is not null) await DisconnectRequested(); };

        Controls.AddRange(
        [
            titleLabel,
            _lifecycleLabel,
            saveTitle,
            _saveDirTextBox,
            _browseButton,
            _saveStatusLabel,
            accountTitle,
            _pairCopyLabel,
            _pairButton,
            _disconnectButton,
            statusTitle,
            _syncStatusLabel,
            _pairingStatusLabel,
            _lastErrorStatusLabel,
            _lastUpdateStatusLabel,
            _autoStartCheckbox,
            _saveButton,
        ]);
    }

    public GatewaySettings CollectSettings(GatewaySettings current) => new()
    {
        Host = current.Host,
        Port = current.Port,
        SaveDir = _saveDirTextBox.Text.Trim(),
        AutoStart = _autoStartCheckbox.Checked,
        DashboardUrl = current.DashboardUrl,
        BackendUrl = current.BackendUrl,
        AccountId = current.AccountId,
        ClientId = current.ClientId,
        SyncToken = current.SyncToken,
    };

    public void ApplySettings(GatewaySettings settings, GatewayHealth? health)
    {
        _appliedSettings = CloneSettings(settings);
        _lastHealth = health;

        if (_saveDirDirty && string.Equals(_saveDirTextBox.Text.Trim(), settings.SaveDir, StringComparison.Ordinal))
        {
            _saveDirDirty = false;
        }

        if (_autoStartDirty && _autoStartCheckbox.Checked == settings.AutoStart)
        {
            _autoStartDirty = false;
        }

        _applyingSettings = true;
        try
        {
            if (!_saveDirDirty && !_saveDirTextBox.Focused)
            {
                _saveDirTextBox.Text = settings.SaveDir;
            }

            if (!_autoStartDirty && !_autoStartCheckbox.Focused)
            {
                _autoStartCheckbox.Checked = settings.AutoStart;
            }
        }
        finally
        {
            _applyingSettings = false;
        }

        RefreshView();
    }

    public void SetBusyState(bool busy, string? statusMessage = null)
    {
        _busy = busy;
        _busyMessage = busy ? statusMessage : null;
        UseWaitCursor = busy;
        RefreshView();
    }

    private void RefreshView()
    {
        var linked = !string.IsNullOrWhiteSpace(_appliedSettings.SyncToken);
        var hasUnsavedChanges = _saveDirDirty || _autoStartDirty;
        var lifecycle = _busy ? "Working" : GatewayStatusPresentation.LifecycleLabel(_lastHealth);
        var validation = _lastHealth?.SaveValidation;
        var syncLabel = _lastHealth?.StatusSummary?.Sync?.Label ?? GatewayStatusPresentation.LifecycleLabel(_lastHealth);
        var syncDetail = _busyMessage ?? GatewayStatusPresentation.LifecycleDetail(_lastHealth);
        var pairingLabel = _lastHealth?.StatusSummary?.Pairing?.Label ?? (linked ? "Paired" : "Ready To Pair");
        var pairingDetail = _lastHealth?.StatusSummary?.Pairing?.Detail ?? GatewayStatusPresentation.PairingMessage(_lastHealth, hasUnsavedChanges);
        var lastUpdate = _lastHealth?.LastSuccessfulAccountUpdateAt ?? "Never";
        var lastUpdateDetail = _lastHealth?.StatusSummary?.DashboardFreshness?.Detail
            ?? "The backend does not have a successful upload from this gateway yet.";
        _lifecycleLabel.Text = lifecycle;
        _lifecycleLabel.BackColor = LifecycleBackColor(lifecycle);
        _lifecycleLabel.ForeColor = LifecycleForeColor(lifecycle);

        _saveStatusLabel.Text = validation?.Message ?? "Choose the folder that contains your active Diablo II save files.";
        _saveStatusLabel.ForeColor = validation?.Valid == true ? Color.FromArgb(137, 223, 157) : Color.FromArgb(243, 237, 225);

        _pairCopyLabel.Text = _busyMessage ?? GatewayStatusPresentation.PairingMessage(_lastHealth, hasUnsavedChanges);
        _pairCopyLabel.ForeColor = _busy ? Color.FromArgb(244, 216, 167) : Color.FromArgb(225, 215, 199);

        _pairButton.Visible = !linked;
        _disconnectButton.Visible = linked;
        _pairButton.Enabled = !_busy && !hasUnsavedChanges && validation?.Valid == true;
        _disconnectButton.Enabled = !_busy;
        _saveButton.Enabled = !_busy && hasUnsavedChanges;
        _browseButton.Enabled = !_busy;
        _saveDirTextBox.Enabled = !_busy;
        _autoStartCheckbox.Enabled = !_busy;

        _syncStatusLabel.Text = $"Sync State: {syncLabel}{Environment.NewLine}{syncDetail}";
        _pairingStatusLabel.Text = $"Pairing: {pairingLabel}{Environment.NewLine}{pairingDetail}";
        _lastErrorStatusLabel.Text = $"Last Error: {GatewayStatusPresentation.ErrorHeadline(_lastHealth)}{Environment.NewLine}{GatewayStatusPresentation.ErrorDetail(_lastHealth)}";
        _lastUpdateStatusLabel.Text = $"Last Account Update: {lastUpdate}{Environment.NewLine}{lastUpdateDetail}";
    }

    private static GatewaySettings CloneSettings(GatewaySettings settings) => new()
    {
        Host = settings.Host,
        Port = settings.Port,
        SaveDir = settings.SaveDir,
        AutoStart = settings.AutoStart,
        DashboardUrl = settings.DashboardUrl,
        BackendUrl = settings.BackendUrl,
        AccountId = settings.AccountId,
        ClientId = settings.ClientId,
        SyncToken = settings.SyncToken,
    };

    private static Color LifecycleBackColor(string lifecycle) => lifecycle switch
    {
        "Connected" => Color.FromArgb(57, 98, 66),
        "Syncing" => Color.FromArgb(92, 68, 31),
        "Error" => Color.FromArgb(98, 43, 39),
        "Blocked" => Color.FromArgb(92, 68, 31),
        "Working" => Color.FromArgb(92, 68, 31),
        _ => Color.FromArgb(49, 45, 41),
    };

    private static Color LifecycleForeColor(string lifecycle) => lifecycle switch
    {
        "Connected" => Color.FromArgb(137, 223, 157),
        "Syncing" => Color.FromArgb(244, 216, 167),
        "Error" => Color.FromArgb(255, 176, 167),
        "Blocked" => Color.FromArgb(244, 216, 167),
        "Working" => Color.FromArgb(244, 216, 167),
        _ => Color.FromArgb(243, 237, 225),
    };

    private void BrowseButtonOnClick(object? sender, EventArgs e)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose the Diablo II Resurrected save folder",
            InitialDirectory = _saveDirTextBox.Text,
            ShowNewFolderButton = false,
        };

        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _saveDirTextBox.Text = dialog.SelectedPath;
            _saveDirDirty = true;
            RefreshView();
        }
    }
}
