using System.Drawing;

namespace D2Wealth.Gateway.Win;

internal sealed class SettingsForm : Form
{
    private readonly TextBox _saveDirTextBox;
    private readonly Label _saveStatusLabel;
    private readonly Label _syncStatusLabel;
    private readonly CheckBox _autoStartCheckbox;
    private readonly Button _saveButton;
    private readonly Button _pairButton;
    private readonly Button _disconnectButton;
    private readonly Button _browseButton;

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
        ClientSize = new Size(480, 320);
        BackColor = Color.FromArgb(20, 17, 15);
        ForeColor = Color.FromArgb(243, 237, 225);

        var saveTitle = new Label { Text = "Save Folder", Left = 18, Top = 18, Width = 120 };
        _saveDirTextBox = new TextBox { Left = 18, Top = 42, Width = 340 };
        _browseButton = new Button { Text = "Browse", Left = 368, Top = 40, Width = 90 };
        _saveStatusLabel = new Label { Left = 18, Top = 74, Width = 440, Height = 40 };

        var accountTitle = new Label { Text = "Account", Left = 18, Top = 122, Width = 120 };
        _pairButton = new Button { Text = "Sign in with Discord", Left = 18, Top = 146, Width = 180, Height = 34 };
        _disconnectButton = new Button { Text = "Disconnect", Left = 210, Top = 146, Width = 120, Height = 34 };
        _syncStatusLabel = new Label { Left = 18, Top = 188, Width = 440, Height = 46 };

        _autoStartCheckbox = new CheckBox
        {
            Text = "Start automatically with Windows",
            Left = 18,
            Top = 244,
            Width = 240,
        };
        _saveButton = new Button { Text = "Save Settings", Left = 318, Top = 238, Width = 140, Height = 34 };

        _browseButton.Click += BrowseButtonOnClick;
        _saveButton.Click += async (_, _) => { if (SaveRequested is not null) await SaveRequested(); };
        _pairButton.Click += async (_, _) => { if (PairRequested is not null) await PairRequested(); };
        _disconnectButton.Click += async (_, _) => { if (DisconnectRequested is not null) await DisconnectRequested(); };

        Controls.AddRange([
            saveTitle,
            _saveDirTextBox,
            _browseButton,
            _saveStatusLabel,
            accountTitle,
            _pairButton,
            _disconnectButton,
            _syncStatusLabel,
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
        _saveDirTextBox.Text = settings.SaveDir;
        _autoStartCheckbox.Checked = settings.AutoStart;

        var linked = !string.IsNullOrWhiteSpace(settings.SyncToken);
        _pairButton.Visible = !linked;
        _disconnectButton.Visible = linked;

        var validation = health?.SaveValidation;
        _saveStatusLabel.Text = validation?.Message ?? "Choose the folder that contains your active Diablo II save files.";
        _saveStatusLabel.ForeColor = validation?.Valid == true ? Color.FromArgb(137, 223, 157) : Color.FromArgb(243, 237, 225);

        _syncStatusLabel.Text = linked
            ? health?.LastBackendSyncAt is not null
                ? $"Connected. Last sync: {health.LastBackendSyncAt}"
                : health?.LastBackendSyncError is not null
                    ? $"Linked, but sync failed: {health.LastBackendSyncError}"
                    : "Linked. Waiting for first backend sync."
            : "Not linked. Sign in with Discord to pair this PC.";
    }

    public void SetBusyState(bool busy, string? statusMessage = null)
    {
        UseWaitCursor = busy;
        _saveButton.Enabled = !busy;
        _pairButton.Enabled = !busy;
        _disconnectButton.Enabled = !busy;
        _browseButton.Enabled = !busy;
        if (!string.IsNullOrWhiteSpace(statusMessage))
        {
            _syncStatusLabel.Text = statusMessage;
        }
    }

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
        }
    }
}
