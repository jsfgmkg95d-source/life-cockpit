# Uses only Windows resource APIs; the target is read as data, never executed.
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-beginupdateresourcew
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-updateresourcew
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-endupdateresourcew
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$IconPath,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$targetFile = Get-Item -LiteralPath $ExecutablePath
$iconFile = Get-Item -LiteralPath $IconPath
if ($targetFile.PSIsContainer -or $targetFile.Extension -ine '.exe') { throw 'Target must be an existing EXE file.' }
if ($iconFile.PSIsContainer -or $iconFile.Extension -ine '.ico') { throw 'Icon must be an existing ICO file.' }

if (-not ('LifeCockpitIconResources' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class LifeCockpitIconResources {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate bool TypeCallback(IntPtr module, IntPtr type, IntPtr extra);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr extra);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr extra);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumResourceTypesW(IntPtr module, TypeCallback callback, IntPtr extra);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, NameCallback callback, IntPtr extra);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr extra);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LockResource(IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr BeginUpdateResourceW(string file, bool deleteExistingResources);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EndUpdateResourceW(IntPtr update, bool discard);

    sealed class Resource {
        public string Type, Name;
        public ushort Language;
        public byte[] Data;
        public string Key { get { return Type + "\0" + Name + "\0" + Language; } }
    }
    sealed class IconEntry {
        public byte[] Directory, Data;
        public string Size { get { return (Directory[0] == 0 ? 256 : Directory[0]) + "x" + (Directory[1] == 0 ? 256 : Directory[1]); } }
    }
    public sealed class Report {
        public string ExecutablePath;
        public bool Verified;
        public int GroupCount, EntriesPerGroup, PreservedNonIconResources;
        public string[] Sizes;
    }
    static Exception NativeError(string action) { return new Win32Exception(Marshal.GetLastWin32Error(), action); }
    static string Name(IntPtr value) {
        return ((ulong)value.ToInt64() >> 16) == 0 ? "#" + value.ToInt64() : Marshal.PtrToStringUni(value);
    }
    static IntPtr NamePointer(string name, out bool allocated) {
        ushort id;
        if (name.StartsWith("#") && ushort.TryParse(name.Substring(1), out id)) { allocated = false; return new IntPtr(id); }
        allocated = true;
        return Marshal.StringToHGlobalUni(name);
    }
    static List<Resource> ReadResources(string path) {
        // LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE: no code execution.
        IntPtr module = LoadLibraryExW(path, IntPtr.Zero, 0x22);
        if (module == IntPtr.Zero) throw NativeError("Load resource data");
        var result = new List<Resource>();
        try {
            TypeCallback types = delegate(IntPtr m, IntPtr type, IntPtr extra) {
                NameCallback names = delegate(IntPtr m2, IntPtr t2, IntPtr name, IntPtr extra2) {
                    LanguageCallback languages = delegate(IntPtr m3, IntPtr t3, IntPtr n3, ushort language, IntPtr extra3) {
                        IntPtr found = FindResourceExW(module, t3, n3, language);
                        if (found == IntPtr.Zero) throw NativeError("Find resource");
                        uint size = SizeofResource(module, found);
                        if (size > Int32.MaxValue) throw new InvalidDataException("Resource is too large.");
                        byte[] bytes = new byte[(int)size];
                        if (size > 0) {
                            IntPtr loaded = LoadResource(module, found);
                            IntPtr pointer = loaded == IntPtr.Zero ? IntPtr.Zero : LockResource(loaded);
                            if (pointer == IntPtr.Zero) throw NativeError("Read resource");
                            Marshal.Copy(pointer, bytes, 0, bytes.Length);
                        }
                        result.Add(new Resource { Type = Name(t3), Name = Name(n3), Language = language, Data = bytes });
                        return true;
                    };
                    if (!EnumResourceLanguagesW(module, t2, name, languages, IntPtr.Zero)) throw NativeError("Enumerate resource languages");
                    return true;
                };
                if (!EnumResourceNamesW(module, type, names, IntPtr.Zero)) throw NativeError("Enumerate resource names");
                return true;
            };
            if (!EnumResourceTypesW(module, types, IntPtr.Zero)) throw NativeError("Enumerate resource types");
        } finally { FreeLibrary(module); }
        return result;
    }
    static List<IconEntry> ReadIcon(string path) {
        byte[] ico = File.ReadAllBytes(path);
        if (ico.Length < 6 || BitConverter.ToUInt16(ico, 0) != 0 || BitConverter.ToUInt16(ico, 2) != 1) throw new InvalidDataException("Invalid ICO header.");
        int count = BitConverter.ToUInt16(ico, 4);
        if (count < 1 || count > 256 || ico.Length < 6 + count * 16) throw new InvalidDataException("Invalid ICO directory.");
        var result = new List<IconEntry>();
        for (int i = 0; i < count; i++) {
            int start = 6 + i * 16;
            uint length = BitConverter.ToUInt32(ico, start + 8), offset = BitConverter.ToUInt32(ico, start + 12);
            if (length == 0 || offset < 6 + count * 16 || (ulong)offset + length > (ulong)ico.Length) throw new InvalidDataException("Invalid ICO image range.");
            byte[] directory = new byte[12], data = new byte[(int)length];
            Buffer.BlockCopy(ico, start, directory, 0, 12);
            Buffer.BlockCopy(ico, (int)offset, data, 0, data.Length);
            result.Add(new IconEntry { Directory = directory, Data = data });
        }
        return result;
    }
    static void Put(IntPtr update, int type, string name, ushort language, byte[] bytes) {
        bool allocated;
        IntPtr pointer = NamePointer(name, out allocated);
        try { if (!UpdateResourceW(update, new IntPtr(type), pointer, language, bytes, (uint)bytes.Length)) throw NativeError("Update icon resource"); }
        finally { if (allocated) Marshal.FreeHGlobal(pointer); }
    }
    static byte[] GroupBytes(List<IconEntry> icons, int firstId) {
        using (var stream = new MemoryStream()) using (var writer = new BinaryWriter(stream)) {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)icons.Count);
            for (int i = 0; i < icons.Count; i++) { writer.Write(icons[i].Directory); writer.Write((ushort)(firstId + i)); }
            return stream.ToArray();
        }
    }
    public static Report Apply(string target, string iconPath, bool verifyOnly) {
        var icons = ReadIcon(iconPath);
        var before = ReadResources(target);
        var groups = before.Where(r => r.Type == "#14").ToList();
        if (!verifyOnly) {
            if (groups.Count == 0) groups.Add(new Resource { Type = "#14", Name = "#1", Language = 0, Data = new byte[0] });
            int firstId = before.Where(r => r.Type == "#3" && r.Name.StartsWith("#")).Select(r => Int32.Parse(r.Name.Substring(1))).DefaultIfEmpty(0).Max() + 1;
            if (firstId + icons.Count - 1 > UInt16.MaxValue) throw new InvalidDataException("No free icon resource IDs.");
            byte[] groupBytes = GroupBytes(icons, firstId);
            IntPtr update = BeginUpdateResourceW(target, false);
            if (update == IntPtr.Zero) throw NativeError("Begin icon update");
            try {
                foreach (ushort language in groups.Select(r => r.Language).Distinct())
                    for (int i = 0; i < icons.Count; i++) Put(update, 3, "#" + (firstId + i), language, icons[i].Data);
                foreach (var group in groups) Put(update, 14, group.Name, group.Language, groupBytes);
                if (!EndUpdateResourceW(update, false)) throw NativeError("Commit icon update");
                update = IntPtr.Zero;
            } finally { if (update != IntPtr.Zero) EndUpdateResourceW(update, true); }
        }
        var after = ReadResources(target);
        // Existing non-icon resources must have identical names, languages and bytes.
        int preserved = 0;
        foreach (var item in before.Where(r => r.Type != "#3" && r.Type != "#14")) {
            var saved = after.SingleOrDefault(r => r.Key == item.Key);
            if (saved == null || !saved.Data.SequenceEqual(item.Data)) throw new InvalidDataException("A non-icon resource changed: " + item.Key);
            preserved++;
        }
        var verifiedGroups = after.Where(r => r.Type == "#14").ToList();
        if (verifiedGroups.Count != groups.Count || verifiedGroups.Count == 0) throw new InvalidDataException("Icon groups are missing.");
        foreach (var group in verifiedGroups) {
            if (group.Data.Length != 6 + icons.Count * 14 || BitConverter.ToUInt16(group.Data, 0) != 0 || BitConverter.ToUInt16(group.Data, 2) != 1 || BitConverter.ToUInt16(group.Data, 4) != icons.Count) throw new InvalidDataException("Icon group directory differs.");
            for (int i = 0; i < icons.Count; i++) {
                int start = 6 + i * 14;
                if (!group.Data.Skip(start).Take(12).SequenceEqual(icons[i].Directory)) throw new InvalidDataException("Icon dimensions or format differ.");
                ushort id = BitConverter.ToUInt16(group.Data, start + 12);
                var image = after.SingleOrDefault(r => r.Type == "#3" && r.Name == "#" + id && r.Language == group.Language);
                if (image == null || !image.Data.SequenceEqual(icons[i].Data)) throw new InvalidDataException("Embedded image bytes differ.");
            }
        }
        return new Report { ExecutablePath = target, Verified = true, GroupCount = verifiedGroups.Count,
            EntriesPerGroup = icons.Count, Sizes = icons.Select(i => i.Size).ToArray(), PreservedNonIconResources = preserved };
    }
}
'@
}

[LifeCockpitIconResources]::Apply($targetFile.FullName, $iconFile.FullName, $VerifyOnly.IsPresent) | ConvertTo-Json -Depth 4
