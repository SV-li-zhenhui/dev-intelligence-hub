using System;
using System.IO;
using System.Text;
using System.Threading;

public static class OfflineBoundedCodex
{
    private const string Result =
        "{\"result\":\"{\\\"schemaVersion\\\":1,\\\"confidence\\\":96,\\\"summary\\\":\\\"Inspect one bounded source file.\\\",\\\"reason\\\":\\\"The fixed offline fixture exercises lifecycle ownership.\\\",\\\"action\\\":{\\\"type\\\":\\\"read_text\\\",\\\"path\\\":\\\"src/app.js\\\"}}\"}";

    public static int Main(string[] arguments)
    {
        string resultFile = null;
        for (var index = 0; index + 1 < arguments.Length; index += 1)
        {
            if (arguments[index] == "--output-last-message")
            {
                resultFile = arguments[index + 1];
                break;
            }
        }
        if (resultFile == null)
        {
            return 2;
        }

        var encoding = new UTF8Encoding(false);
        File.WriteAllText("offline-cli-started", "started", encoding);
        for (var attempt = 0; attempt < 6000; attempt += 1)
        {
            if (File.Exists("offline-cli-release"))
            {
                File.WriteAllText(resultFile, Result, encoding);
                return 0;
            }
            Thread.Sleep(10);
        }
        return 3;
    }
}
