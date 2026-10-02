using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Input;

namespace Spool.App;

public sealed class GlobalHotkeyManager : IDisposable
{
    private const int WmHotkey = 0x0312;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private const uint ModWin = 0x0008;
    private const uint ModNoRepeat = 0x4000;
    private readonly HwndSource _source;
    private readonly Dictionary<int, string> _registered = [];
    private readonly HwndSourceHook _hook;
    private int _nextId = 100;

    public event Action<string>? Pressed;

    public GlobalHotkeyManager(Window window)
    {
        var handle = new WindowInteropHelper(window).Handle;
        _source = HwndSource.FromHwnd(handle) ?? throw new InvalidOperationException("Could not attach the Windows hotkey listener.");
        _hook = WindowProcedure;
        _source.AddHook(_hook);
    }

    public IReadOnlyList<string> Register(IReadOnlyDictionary<string, string> hotkeys)
    {
        UnregisterAll();
        var errors = new List<string>();
        foreach (var pair in hotkeys)
        {
            if (!TryParse(pair.Value, out var key, out var modifiers))
            {
                errors.Add($"{pair.Key}: {pair.Value}");
                continue;
            }
            var id = ++_nextId;
            if (!RegisterHotKey(_source.Handle, id, modifiers | ModNoRepeat, key))
            {
                errors.Add($"{pair.Key}: {pair.Value}");
                continue;
            }
            _registered[id] = pair.Key;
        }
        return errors;
    }

    public void Dispose()
    {
        UnregisterAll();
        _source.RemoveHook(_hook);
    }

    private void UnregisterAll()
    {
        foreach (var id in _registered.Keys) UnregisterHotKey(_source.Handle, id);
        _registered.Clear();
    }

    private IntPtr WindowProcedure(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == WmHotkey && _registered.TryGetValue(wParam.ToInt32(), out var name))
        {
            Pressed?.Invoke(name);
            handled = true;
        }
        return IntPtr.Zero;
    }

    private static bool TryParse(string specification, out uint virtualKey, out uint modifiers)
    {
        virtualKey = 0;
        modifiers = 0;
        var parts = specification.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return false;
        for (var index = 0; index < parts.Length - 1; index++)
        {
            var flag = parts[index].ToUpperInvariant() switch
            {
                "CTRL" => ModControl,
                "ALT" => ModAlt,
                "SHIFT" => ModShift,
                "WIN" => ModWin,
                _ => 0u
            };
            if (flag == 0) return false;
            modifiers |= flag;
        }
        if (!Enum.TryParse<Key>(parts[^1], true, out var key) || key is Key.None or Key.LeftCtrl or Key.RightCtrl or Key.LeftAlt or Key.RightAlt or Key.LeftShift or Key.RightShift or Key.LWin or Key.RWin)
            return false;
        virtualKey = (uint)KeyInterop.VirtualKeyFromKey(key);
        return virtualKey > 0;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
