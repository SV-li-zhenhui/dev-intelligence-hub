using System;
using System.Text;

public static class OfflineGitHubToken
{
    private const string Token = "ghp_fictionalCredentialValue123456789";

    public static int Main(string[] arguments)
    {
        string[] expected = {
            "auth",
            "token",
            "--hostname",
            "github.com",
            "--user",
            "owner-login"
        };
        if (arguments.Length != expected.Length)
        {
            return 2;
        }
        for (var index = 0; index < expected.Length; index += 1)
        {
            if (!String.Equals(arguments[index], expected[index], StringComparison.Ordinal))
            {
                return 3;
            }
        }

        byte[] output = new UTF8Encoding(false).GetBytes(Token);
        Console.OpenStandardOutput().Write(output, 0, output.Length);
        return 0;
    }
}
