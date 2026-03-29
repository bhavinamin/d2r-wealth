namespace D2Wealth.Gateway.Win;

internal sealed class GatewayLogger : IDisposable
{
    private readonly object _sync = new();
    private readonly StreamWriter _writer;

    public string LogPath { get; }

    public GatewayLogger(string rootPath)
    {
        Directory.CreateDirectory(rootPath);
        LogPath = Path.Combine(rootPath, "gateway-win.log");
        _writer = new StreamWriter(new FileStream(LogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
        {
            AutoFlush = true,
        };
    }

    public void Info(string message) => Write("INFO", message);

    public void Warn(string message) => Write("WARN", message);

    public void Error(string message, Exception? error = null)
    {
        if (error is null)
        {
            Write("ERROR", message);
            return;
        }

        Write("ERROR", $"{message}{Environment.NewLine}{error}");
    }

    private void Write(string level, string message)
    {
        var line = $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}] {level} {message}";
        lock (_sync)
        {
            Console.WriteLine(line);
            _writer.WriteLine(line);
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            _writer.Dispose();
        }
    }
}
