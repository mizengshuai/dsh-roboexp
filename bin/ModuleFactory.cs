// ModuleFactory.exe — RoboEXP route-B factory: generate CodeFunc modules / CodeApp apps
// (.rcu + .c + UserInclude.xml registration) and wrap JMCompiler, all without the GUI.
//
// Commands:
//   module  <spec.json>            generate user subroutine module (CodeFunc)
//   app     <spec.json>            generate code main program (CodeApp)
//   register   <rcuPath> <softwareType> [band]      add to UserInclude.xml
//   unregister <rcuPath> <softwareType>             remove from UserInclude.xml
//   listlib <softwareType>         list registered user modules
//   compile <cFile> <main|func> <softwareType>      invoke JMCompiler, stream output
//   compilestrict <cFile> <softwareType>            full-link probe compile of a module (JSON verdict)
//   apis <softwareType> [nameFilter]                dump API table from JMLib.xml as JSON
//
// module/app/listlib/apis/compilestrict print JSON on stdout (warnings go to stderr).
// RoboEXP location: ROBOEXP_DIR env var -> %APPDATA%\RoboEXP -> hardcoded fallback.
//
// Must be compiled x86 (RoboExp.exe is 32-bit):
//   csc -nologo -platform:x86 -r:System.Web.Extensions.dll -out:ModuleFactory.exe ModuleFactory.cs
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization.Formatters.Binary;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml;

class ModuleFactory
{
    static readonly string roboDir = ResolveRoboDir();
    static Assembly roboAsm;

    // ROBOEXP_DIR env var -> %APPDATA%\RoboEXP -> last-known path on this machine
    static string ResolveRoboDir()
    {
        string env = Environment.GetEnvironmentVariable("ROBOEXP_DIR");
        if (!string.IsNullOrEmpty(env) && File.Exists(Path.Combine(env, "RoboExp.exe"))) return env;
        string def = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RoboEXP");
        if (File.Exists(Path.Combine(def, "RoboExp.exe"))) return def;
        return @"C:\Users\Mi\AppData\Roaming\RoboEXP";
    }

    static Assembly OnResolve(object sender, ResolveEventArgs args)
    {
        string name = new AssemblyName(args.Name).Name;
        foreach (string ext in new[] { ".dll", ".exe" })
        {
            string p = Path.Combine(roboDir, name + ext);
            if (File.Exists(p)) return Assembly.LoadFrom(p);
        }
        return null;
    }

    static int Main(string[] argv)
    {
        if (argv.Length < 1) { Usage(); return 2; }
        AppDomain.CurrentDomain.AssemblyResolve += OnResolve;
        Console.OutputEncoding = Encoding.UTF8;
        roboAsm = Assembly.LoadFrom(Path.Combine(roboDir, "RoboExp.exe"));
        try
        {
            switch (argv[0].ToLowerInvariant())
            {
                case "module": return CmdModule(argv[1]);
                case "app": return CmdApp(argv[1]);
                case "register": return CmdRegister(argv[1], argv[2], argv.Length > 3 ? argv[3] : "AI 模块");
                case "unregister": return CmdUnregister(argv[1], argv[2]);
                case "listlib": return CmdListLib(argv[1]);
                case "compile": return CmdCompile(argv[1], argv[2], argv[3]);
                case "compilestrict": return CmdCompileStrict(argv[1], argv[2]);
                case "apis": return CmdApis(argv[1], argv.Length > 2 ? argv[2] : null);
                case "info": return CmdInfo(argv[1]);
                case "detach": return CmdDetach(argv[1], argv[2]);
                case "peekdirs": return CmdPeekDirs(argv.Skip(1).ToArray());
                case "controllers": return CmdControllers();
                case "examples": return CmdExamples(argv[1], argv.Length > 2 ? argv[2] : null);
                case "sysicons": return CmdSysIcons(argv[1], argv.Length > 2 ? argv[2] : null);
                default: Usage(); return 2;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERROR: " + ex);
            return 1;
        }
    }

    static void Usage()
    {
        Console.WriteLine("module <spec.json> | app <spec.json> | register <rcu> <type> [band] |");
        Console.WriteLine("unregister <rcu> <type> | listlib <type> | compile <c> <main|func> <type> |");
        Console.WriteLine("compilestrict <c> <type> | apis <type> [filter] | info <rcu> |");
        Console.WriteLine("detach <project.rcu> <moduleName> | peekdirs <dir> [dir...]");
        Console.WriteLine("controllers | examples <type> [query]");
    }

    static string ToJson(object o)
    {
        return new JavaScriptSerializer { MaxJsonLength = 1 << 24 }.Serialize(o);
    }

    // ---------------- project attachment (GUI-native private subroutines) ----------------
    // A private subroutine of a project = its .rcu/.c files sit NEXT TO the project file, and
    // its ProjectInfo is listed in the project's m_UsedProjectInfoList (exactly what the GUI's
    // 引用子程序/新建子程序 do). On project open the GUI re-resolves "projectdir/<Name>.rcu"
    // and refreshes the snapshot, so only the name has to be right.

    static void RemoveUsedByName(object usedList, string moduleName)
    {
        var doomed = new List<object>();
        foreach (object u in (IEnumerable)usedList)
            if (string.Compare((string)GF(u, "m_ProjectName"), moduleName, false) == 0) doomed.Add(u);
        foreach (object u in doomed) InvokeListMethod(usedList, "Remove", u);
    }

    static void InvokeListMethod(object list, string method, object arg)
    {
        foreach (MethodInfo m in list.GetType().GetMethods())
            if (m.Name == method && m.GetParameters().Length == 1)
            { m.Invoke(list, new[] { arg }); return; }
        throw new Exception("EventArrayList has no " + method + "(object) on " + list.GetType().FullName);
    }

    static void AttachModuleToProject(string projectRcu, string moduleRcu, string moduleName)
    {
        object rcu;
        using (var fs = File.OpenRead(projectRcu)) rcu = new BinaryFormatter().Deserialize(fs);
        object data = GetProp(rcu, "CodeData") ?? GetProp(rcu, "FlowData");
        if (data == null) throw new Exception("not a project file: " + projectRcu);
        object pd = GetProp(data, "ProjectData");
        string projName = (string)GetProp(GetProp(pd, "ProjectInfo"), "ProjectName");
        if (string.Compare(projName, moduleName, false) == 0)
            throw new Exception("module name cannot equal the project's own name");
        object usedList = GF(pd, "m_UsedProjectInfoList");
        RemoveUsedByName(usedList, moduleName);
        AddToEventArrayList(usedList, LoadProjectInfoFromRcu(moduleRcu));
        using (var fs = File.Create(projectRcu)) new BinaryFormatter().Serialize(fs, rcu);
    }

    static int CmdDetach(string projectRcu, string moduleName)
    {
        projectRcu = Path.GetFullPath(projectRcu);
        object rcu;
        using (var fs = File.OpenRead(projectRcu)) rcu = new BinaryFormatter().Deserialize(fs);
        object data = GetProp(rcu, "CodeData") ?? GetProp(rcu, "FlowData");
        if (data == null) throw new Exception("not a project file: " + projectRcu);
        object pd = GetProp(data, "ProjectData");
        object usedList = GF(pd, "m_UsedProjectInfoList");
        RemoveUsedByName(usedList, moduleName);
        using (var fs = File.Create(projectRcu)) new BinaryFormatter().Serialize(fs, rcu);
        Console.WriteLine(ToJson(new Dictionary<string, object> { { "ok", true }, { "detached", moduleName }, { "project", projectRcu } }));
        return 0;
    }

    // Scan directories recursively for .rcu files and peek at their type/name — lets the agent
    // discover the user's RoboEXP projects (graphical or code) without opening the GUI.
    static void WalkRcuFiles(string dir, int depth, List<string> files)
    {
        if (depth > 5 || files.Count > 500) return;
        foreach (string f in Directory.GetFiles(dir, "*.rcu"))
        {
            files.Add(f);
            if (files.Count > 500) return;
        }
        foreach (string d in Directory.GetDirectories(dir))
        {
            string n = Path.GetFileName(d).ToLowerInvariant();
            if (n == "node_modules" || n == ".git" || n == "bin" || n == "obj") continue;
            WalkRcuFiles(d, depth + 1, files);
        }
    }

    static int CmdPeekDirs(string[] dirs)
    {
        var files = new List<string>();
        foreach (string d in dirs)
        {
            string abs = Path.GetFullPath(d);
            if (Directory.Exists(abs)) WalkRcuFiles(abs, 0, files);
        }
        var list = new List<Dictionary<string, object>>();
        foreach (string f in files)
        {
            var o = new Dictionary<string, object> { { "path", f }, { "type", "?" } };
            try
            {
                object rcu;
                using (var fs = File.OpenRead(f)) rcu = new BinaryFormatter().Deserialize(fs);
                o["type"] = GetProp(rcu, "ProjectType").ToString();
                object data = GetProp(rcu, "CodeData") ?? GetProp(rcu, "FlowData");
                object nm = data == null ? null : GetProp(GetProp(data, "ProjectData"), "ProjectInfo");
                o["name"] = nm == null ? Path.GetFileNameWithoutExtension(f) : GetProp(nm, "ProjectName");
            }
            catch { }
            o["mtime"] = File.GetLastWriteTime(f).ToString("yyyy-MM-dd HH:mm:ss");
            list.Add(o);
        }
        var sorted = list.OrderByDescending(o => (string)o["mtime"]).ToList();
        Console.WriteLine(ToJson(sorted));
        return 0;
    }

    // Official system icon catalog: every PNG under Robots\<type>\Include\Icons is a valid
    // "system:Name" icon spec. Optional name filter.
    static int CmdSysIcons(string swType, string filter)
    {
        string dir = Path.Combine(roboDir, "Robots", swType, "Include", "Icons");
        var list = new List<string>();
        if (Directory.Exists(dir))
            foreach (string f in Directory.GetFiles(dir, "*.png"))
            {
                string n = Path.GetFileNameWithoutExtension(f);
                if (filter != null && filter.Length > 0 && n.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                list.Add(n);
            }
        Console.WriteLine(ToJson(new Dictionary<string, object>
        {
            { "softwareType", swType }, { "count", list.Count }, { "icons", list },
        }));
        return 0;
    }

    // ---------------- controller & example catalogs ----------------

    // All installed controller types with their real API count (//Func in JMlib.xml),
    // example count, and whether the kernel really exports <T>_Init (checked by scanning
    // the jmkernel.o symbol table bytes, not by trusting a naming convention).
    static int CmdControllers()
    {
        var list = new List<Dictionary<string, object>>();
        string robots = Path.Combine(roboDir, "Robots");
        foreach (string dir in Directory.GetDirectories(robots))
        {
            string t = Path.GetFileName(dir);
            if (t == "Default") continue;
            var o = new Dictionary<string, object> { { "type", t } };
            string jmlib = Path.Combine(dir, "Include", "JMlib.xml");
            o["apiCount"] = 0;
            if (File.Exists(jmlib))
            {
                var doc = new XmlDocument(); doc.Load(jmlib);
                o["apiCount"] = doc.SelectNodes("//Func").Count;
            }
            string exDir = Path.Combine(dir, "Examples");
            int exCount = 0;
            if (Directory.Exists(exDir))
                exCount = Directory.GetFiles(exDir, "*.rcu", SearchOption.AllDirectories).Length;
            o["exampleCount"] = exCount;
            o["initFunc"] = false;
            string kern = Path.Combine(dir, "Include", "o", "jmkernel.o");
            if (File.Exists(kern))
            {
                string symbols = Encoding.ASCII.GetString(File.ReadAllBytes(kern));
                o["initFunc"] = symbols.IndexOf(t + "_Init") >= 0;
                if ((bool)o["initFunc"]) o["initFuncName"] = t + "_Init";
            }
            list.Add(o);
        }
        Console.WriteLine(ToJson(list));
        return 0;
    }

    // Official example index from Examples.xml: folder / caption / resolved .rcu path.
    static int CmdExamples(string swType, string query)
    {
        string exXml = Path.Combine(roboDir, "Robots", swType, "Examples", "Examples.xml");
        var list = new List<Dictionary<string, object>>();
        if (File.Exists(exXml))
        {
            var doc = new XmlDocument(); doc.Load(exXml);
            foreach (XmlElement folder in doc.SelectNodes("//Folder"))
            {
                string folderName = folder.GetAttribute("Name");
                foreach (XmlElement file in folder.SelectNodes("File"))
                {
                    string id = file.InnerText.Trim();
                    if (query != null && query.Length > 0 &&
                        (id.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0 &&
                         file.GetAttribute("CHS").IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0 &&
                         file.GetAttribute("Default").IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0)) continue;
                    string rcu = Path.Combine(roboDir, "Robots", swType, "Examples", folderName, id, id + ".rcu");
                    if (!File.Exists(rcu))
                    {
                        // fall back: search the Examples tree for <id>/<id>.rcu
                        string exDir = Path.Combine(roboDir, "Robots", swType, "Examples");
                        foreach (string d in Directory.GetDirectories(exDir))
                        {
                            string alt = Path.Combine(d, id, id + ".rcu");
                            if (File.Exists(alt)) { rcu = alt; break; }
                        }
                    }
                    list.Add(new Dictionary<string, object>
                    {
                        { "folder", folderName },
                        { "name", id },
                        { "caption", file.GetAttribute("CHS") },
                        { "rcu", File.Exists(rcu) ? rcu : "" },
                        { "exists", File.Exists(rcu) },
                    });
                }
            }
        }
        Console.WriteLine(ToJson(list));
        return 0;
    }

    // ---------------- spec loading ----------------
    static Dictionary<string, object> LoadSpec(string path)
    {
        var js = new JavaScriptSerializer { MaxJsonLength = 1 << 24 };
        return js.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    }

    static string S(Dictionary<string, object> d, string k, string def = "") { return d.ContainsKey(k) && d[k] != null ? Convert.ToString(d[k]) : def; }

    static List<Dictionary<string, object>> L(Dictionary<string, object> d, string k)
    {
        var r = new List<Dictionary<string, object>>();
        if (!d.ContainsKey(k)) return r;
        var en = d[k] as IEnumerable;   // JavaScriptSerializer yields ArrayList for JSON arrays
        if (en == null) return r;
        foreach (var o in en)
        {
            var dd = o as Dictionary<string, object>;
            if (dd != null) r.Add(dd);
        }
        return r;
    }

    static List<string> LS(Dictionary<string, object> d, string k)
    {
        var r = new List<string>();
        if (!d.ContainsKey(k)) return r;
        var en = d[k] as IEnumerable;
        if (en == null) return r;
        foreach (var o in en) r.Add(Convert.ToString(o));
        return r;
    }

    // ---------------- reflection helpers ----------------
    static FieldInfo FindField(Type t, string f)
    {
        while (t != null)
        {
            var fi = t.GetField(f, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            if (fi != null) return fi;
            t = t.BaseType;
        }
        return null;
    }

    static object GF(object o, string f)
    {
        var fi = FindField(o.GetType(), f);
        if (fi == null) throw new Exception("no field " + f + " on " + o.GetType().Name);
        return fi.GetValue(o);
    }

    static void SF(object o, string f, object v)
    {
        var fi = FindField(o.GetType(), f);
        if (fi == null) throw new Exception("no field " + f + " on " + o.GetType().Name);
        fi.SetValue(o, v is string && fi.FieldType != typeof(string) ? Convert.ChangeType(v, fi.FieldType) : v);
    }

    static void SetProp(object o, string p, object v)
    {
        var pi = o.GetType().GetProperty(p, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (pi == null) throw new Exception("no property " + p + " on " + o.GetType().Name);
        pi.SetValue(o, v is string && pi.PropertyType != typeof(string) ? Convert.ChangeType(v, pi.PropertyType) : v, null);
    }

    // ---------------- core object builders ----------------
    static object BuildProjectInfo(string name, string caption, string desc, string swType,
        string returnType, string userName, string userVersion, string projectPath, Bitmap icon)
    {
        object pi = Activator.CreateInstance(roboAsm.GetType("RoboExp.ProjectInfo"));
        SetProp(pi, "ProjectName", name);
        SetProp(pi, "ProjectCaption", string.IsNullOrEmpty(caption) ? name : caption);
        SetProp(pi, "ProjectDescription", desc ?? "");
        SetProp(pi, "ProjectPath", projectPath);
        SetProp(pi, "UserVersion", string.IsNullOrEmpty(userVersion) ? "1.0" : userVersion);
        SetProp(pi, "UserName", string.IsNullOrEmpty(userName) ? "AI" : userName);
        SetProp(pi, "ProjectType", Enum.Parse(FindField(pi.GetType(), "m_ProjectType").FieldType, "CodeFunc"));
        SetProp(pi, "SoftwareType", Enum.Parse(FindField(pi.GetType(), "m_SoftwareType").FieldType, swType));
        object rt = GF(pi, "m_ReturnType");
        SF(rt, "m_Type", string.IsNullOrEmpty(returnType) ? "void" : returnType);
        SF(rt, "m_Description", returnType == "void" ? "无返回" : "返回 " + returnType);
        SetProp(pi, "ProjectIcon", icon);
        return pi;
    }

    static void AddParam(object projectInfo, Dictionary<string, object> p)
    {
        object pc = Activator.CreateInstance(roboAsm.GetType("RoboExp.ParameterClass"));
        SF(pc, "m_Name", S(p, "name"));
        SF(pc, "m_Type", S(p, "type", "int"));
        SF(pc, "m_DefaultValue", S(p, "default"));
        SF(pc, "m_Min", S(p, "min"));
        SF(pc, "m_Max", S(p, "max"));
        SF(pc, "m_Description", S(p, "desc"));
        string t = S(p, "type", "int");
        SF(pc, "m_IsHardwareType", t.StartsWith("_") && t.EndsWith("_"));
        SF(pc, "m_IsEnumType", false);
        string nchs = S(p, "nameCHS");
        SF(pc, "m_NameCHS", nchs);
        SF(pc, "m_NameCHT", nchs);
        SF(pc, "m_NameDefault", nchs.Length > 0 ? nchs : S(p, "name"));
        ((ArrayList)GF(projectInfo, "m_ParamList")).Add(pc);
    }

    // GUI hardware param types (_MOTOR_/_PORT_/...) are not C types: official JMLib
    // signatures declare such params as uint8_t (e.g. void SetMotor(uint8_t which, int speed)).
    static string CTypeOf(string guiType)
    {
        if (guiType.Length > 2 && guiType.StartsWith("_") && guiType.EndsWith("_")) return "uint8_t";
        return guiType;
    }

    static string BuildSignature(string returnType, string name, List<Dictionary<string, object>> pars)
    {
        var sb = new StringBuilder();
        sb.Append(string.IsNullOrEmpty(returnType) ? "void" : returnType).Append(' ').Append(name).Append('(');
        for (int i = 0; i < pars.Count; i++)
            sb.Append(i == 0 ? "" : ", ").Append(CTypeOf(S(pars[i], "type", "int"))).Append(' ').Append(S(pars[i], "name"));
        return sb.Append(')').ToString();
    }

    // Whole-file idempotent guard: Global opens "#ifndef _NAME_ / #define _NAME_", the body
    // (m_Code) ends with the matching "#endif". This keeps nested includes (app -> B.c -> A.c)
    // free of redefinitions, and FrmCodeFunc's save (Global + signature + Code) reproduces it.
    static string BuildGlobal(string name, List<string> sysDeps, List<string> userDeps)
    {
        var sb = new StringBuilder();
        string guard = "_" + name.ToUpperInvariant() + "_";
        sb.Append("#ifndef ").Append(guard).Append("\r\n#define ").Append(guard).Append("\r\n#include <JMLib.c>\r\n");
        foreach (string d in sysDeps)
        {
            string g = "_" + d.ToUpperInvariant() + "_";
            sb.Append("#ifndef ").Append(g).Append("\r\n#define ").Append(g).Append("\r\n#include <JMLib.c>\r\n#endif\r\n");
        }
        foreach (string u in userDeps) sb.Append("#include \"").Append(u).Append(".c\"\r\n");
        return sb.ToString();
    }

    static string NormalizeBody(string code, string indent)
    {
        code = code.Replace("\r\n", "\n").Trim('\n', ' ', '\t');
        if (!code.StartsWith("{"))
        {
            var sb = new StringBuilder("{\n");
            foreach (string line in code.Split('\n')) sb.Append(indent).Append(line).Append('\n');
            code = sb.Append('}').ToString();
        }
        return code + "\n#endif";
    }

    // icon: "system:ApiName" reuses an official module icon (same visual style as the built-in
    // library); "platform:Name" reuses an icon extracted from the 中鸣通用PID编程平台 modules
    // (bin/icons/ next to this exe); a path loads that PNG; otherwise a letter tile is drawn.
    static string swTypeForIcons = "E7RCU";

    static Bitmap LoadOrMakeIcon(string iconSpec, string label)
    {
        if (!string.IsNullOrEmpty(iconSpec))
        {
            if (iconSpec.StartsWith("system:", StringComparison.OrdinalIgnoreCase))
            {
                string sysIcon = Path.Combine(roboDir, "Robots", swTypeForIcons, "Include", "Icons",
                    iconSpec.Substring(7).Trim() + ".png");
                if (File.Exists(sysIcon))
                    using (var ms = new MemoryStream(File.ReadAllBytes(sysIcon)))
                        return new Bitmap(ms);
                Console.Error.WriteLine("WARN system icon not found: " + sysIcon);
            }
            else if (iconSpec.StartsWith("platform:", StringComparison.OrdinalIgnoreCase))
            {
                // third-party competition platform icon: resolved at runtime from the user's
                // LOCAL platform copy (never bundled with this tool) via ROBOEXP_PID_DIR
                string pidDir = Environment.GetEnvironmentVariable("ROBOEXP_PID_DIR");
                string platRcu = string.IsNullOrEmpty(pidDir) ? ""
                    : Path.Combine(pidDir, iconSpec.Substring(9).Trim() + ".rcu");
                Bitmap platBmp = null;
                if (File.Exists(platRcu))
                {
                    try
                    {
                        using (var fs = File.OpenRead(platRcu))
                        {
                            object pr = new BinaryFormatter().Deserialize(fs);
                            object pdata = GetProp(pr, "CodeData") ?? GetProp(pr, "FlowData");
                            platBmp = (Bitmap)GetProp(GetProp(GetProp(pdata, "ProjectData"), "ProjectInfo"), "ProjectIcon");
                        }
                    }
                    catch (Exception ex) { Console.Error.WriteLine("WARN platform icon read failed: " + ex.Message); }
                }
                if (platBmp != null) return platBmp;
                Console.Error.WriteLine("WARN platform icon not found: " + platRcu + " (set ROBOEXP_PID_DIR to the platform 竞赛程序 folder)");
            }
            else if (File.Exists(iconSpec))
            {
                using (var ms = new MemoryStream(File.ReadAllBytes(iconSpec)))
                    return new Bitmap(ms);
            }
        }
        return DrawLetterIcon(label.Length > 0 ? label[0] : 'M');
    }

    static Bitmap DrawLetterIcon(char c)
    {
        var bmp = new Bitmap(32, 32);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var b = new SolidBrush(Color.White))
                g.FillRectangle(b, 0, 0, 32, 32);
            using (var p = new Pen(Color.FromArgb(190, 190, 190), 1.5f))
                g.DrawRectangle(p, 1, 1, 29, 29);
            using (var f = new Font("Arial", 13, FontStyle.Bold))
            using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                g.DrawString(c.ToString(), f, new SolidBrush(Color.FromArgb(40, 90, 170)), new RectangleF(0, 0, 32, 32), sf);
        }
        return bmp;
    }

    // ---------------- module command ----------------
    static int CmdModule(string specPath)
    {
        var spec = LoadSpec(specPath);
        string name = S(spec, "name");
        if (name.Length == 0) throw new Exception("spec missing 'name'");
        string swType = S(spec, "softwareType", "E7RCU");
        string attachTo = S(spec, "attachTo");
        if (attachTo.Length > 0)
        {
            attachTo = Path.GetFullPath(attachTo);
            if (!File.Exists(attachTo)) throw new Exception("project not found: " + attachTo);
        }
        string outDir = Path.GetFullPath(S(spec, "outDir", "."));
        if (attachTo.Length > 0) outDir = Path.GetDirectoryName(attachTo);   // private subroutine: next to the project
        Directory.CreateDirectory(outDir);
        string rcuPath = Path.Combine(outDir, name + ".rcu");

        // guard: no clash with system modules
        if (IsSystemFunc(swType, name)) throw new Exception(name + " conflicts with a system module name");

        var pars = L(spec, "params");
        var sysDeps = LS(spec, "sysDeps");
        var userDeps = LS(spec, "userDeps");
        // auto-collect: every system API name appearing verbatim in the code gets its
        // JMLib.c conditional-include block, exactly like the Python layer used to do
        string codeText = S(spec, "code");
        foreach (string api in LoadApiNames(swType))
            if (!sysDeps.Contains(api) && Regex.IsMatch(codeText, @"\b" + Regex.Escape(api) + @"\b"))
                sysDeps.Add(api);
        sysDeps.Sort();
        string returnType = S(spec, "returnType", "void");

        swTypeForIcons = swType;
        Bitmap icon = LoadOrMakeIcon(S(spec, "icon"), name);
        object projectInfo = BuildProjectInfo(name, S(spec, "caption"), S(spec, "description"), swType,
            returnType, S(spec, "author"), S(spec, "version"), rcuPath, icon);
        foreach (var p in pars) AddParam(projectInfo, p);

        object projectData = Activator.CreateInstance(roboAsm.GetType("RoboExp.ProjectData"));
        SetProp(projectData, "ProjectInfo", projectInfo);
        SetProp(GetProp(projectData, "HardwareTable"), "SoftwareType",
            Enum.Parse(FindField(projectInfo.GetType(), "m_SoftwareType").FieldType, swType));

        string global = BuildGlobal(name, sysDeps, userDeps);
        string body = NormalizeBody(S(spec, "code"), "    ");
        object frame = GF(projectData, "m_CodeFrameData");
        SF(frame, "m_Global", global);
        SF(frame, "m_Func", "");
        SF(frame, "m_Code", body);
        SF(frame, "m_AllCode", "");

        // UsedProjectInfoList: snapshot of each referenced user module's ProjectInfo
        object usedList = GF(projectData, "m_UsedProjectInfoList");
        foreach (string dep in userDeps)
        {
            string depRcu = Path.Combine(outDir, dep + ".rcu");
            if (!File.Exists(depRcu)) throw new Exception("userDep " + dep + " not found at " + depRcu);
            object depPi = LoadProjectInfoFromRcu(depRcu);
            AddToEventArrayList(usedList, depPi);
        }

        object codeData = Activator.CreateInstance(roboAsm.GetType("RoboExp.CodeData"));
        SetProp(codeData, "ProjectData", projectData);
        object rcu = Activator.CreateInstance(roboAsm.GetType("RoboExp.RCUFile"));
        SetProp(rcu, "ProjectType", Enum.Parse(roboAsm.GetType("RoboExp.ProjectType"), "CodeFunc"));
        SetProp(rcu, "CodeData", codeData);

        using (var fs = File.Create(rcuPath)) new BinaryFormatter().Serialize(fs, rcu);

        // companion .c — matches FrmCodeFunc.SaveCode: Global + "\r\n\r\n" + signature + "\r\n" + body + "\r\n"
        string cPath = Path.Combine(outDir, name + ".c");
        File.WriteAllText(cPath, global + "\r\n\r\n" + BuildSignature(returnType, name, pars) + "\r\n" + body.Replace("\n", "\r\n") + "\r\n", Encoding.Default);

        string band = S(spec, "band", "AI 模块");
        // modules are plain files now: no global library registration unless explicitly asked
        bool reg = attachTo.Length == 0 && S(spec, "register", "false").ToLowerInvariant() == "true";
        if (reg) RegisterRcu(rcuPath, swType, band);
        if (attachTo.Length > 0) AttachModuleToProject(attachTo, rcuPath, name);
        Console.WriteLine(ToJson(new Dictionary<string, object>
        {
            { "ok", true }, { "name", name }, { "rcu", rcuPath }, { "c", cPath },
            { "sysDeps", sysDeps }, { "userDeps", userDeps },
            { "registered", reg }, { "band", band },
            { "attachedTo", attachTo },
        }));
        return 0;
    }

    static List<string> LoadApiNames(string swType)
    {
        var r = new List<string>();
        string xml = Path.Combine(roboDir, "Robots", swType, "Include", "JMlib.xml");
        if (!File.Exists(xml)) return r;
        var doc = new XmlDocument(); doc.Load(xml);
        foreach (XmlElement f in doc.SelectNodes("//Func"))
        {
            XmlNode n = f.SelectSingleNode("Name");
            if (n != null) r.Add(n.InnerText.Trim());
        }
        return r;
    }

    static object GetProp(object o, string p)
    {
        return o.GetType().GetProperty(p, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).GetValue(o, null);
    }

    static object LoadProjectInfoFromRcu(string path)
    {
        using (var fs = File.OpenRead(path))
        {
            object rcu = new BinaryFormatter().Deserialize(fs);
            object data = GetProp(rcu, "CodeData") ?? GetProp(rcu, "FlowData");
            return GetProp(GetProp(data, "ProjectData"), "ProjectInfo");
        }
    }

    // ---------------- app command ----------------
    static int CmdApp(string specPath)
    {
        var spec = LoadSpec(specPath);
        string name = S(spec, "name");
        string swType = S(spec, "softwareType", "E7RCU");
        string outDir = Path.GetFullPath(S(spec, "outDir", "."));
        Directory.CreateDirectory(outDir);
        string rcuPath = Path.Combine(outDir, name + ".rcu");

        string code = S(spec, "code").Replace("\r\n", "\n");
        swTypeForIcons = swType;
        Bitmap icon = LoadOrMakeIcon(S(spec, "icon"), name);

        object projectInfo = BuildProjectInfo(name, S(spec, "caption"), S(spec, "description"), swType,
            "void", S(spec, "author"), S(spec, "version"), rcuPath, icon);
        // CodeApp type override
        SetProp(projectInfo, "ProjectType", Enum.Parse(roboAsm.GetType("RoboExp.ProjectType"), "CodeApp"));

        object projectData = Activator.CreateInstance(roboAsm.GetType("RoboExp.ProjectData"));
        SetProp(projectData, "ProjectInfo", projectInfo);
        SetProp(GetProp(projectData, "HardwareTable"), "SoftwareType",
            Enum.Parse(FindField(projectInfo.GetType(), "m_SoftwareType").FieldType, swType));

        object frame = GF(projectData, "m_CodeFrameData");
        SF(frame, "m_Global", "");
        SF(frame, "m_Func", "");
        SF(frame, "m_Code", code);
        SF(frame, "m_AllCode", "");

        object usedList = GF(projectData, "m_UsedProjectInfoList");
        foreach (string dep in LS(spec, "userDeps"))
        {
            string depRcu = Path.Combine(outDir, dep + ".rcu");
            if (File.Exists(depRcu))
                AddToEventArrayList(usedList, LoadProjectInfoFromRcu(depRcu));
        }

        object codeData = Activator.CreateInstance(roboAsm.GetType("RoboExp.CodeData"));
        SetProp(codeData, "ProjectData", projectData);
        object rcu = Activator.CreateInstance(roboAsm.GetType("RoboExp.RCUFile"));
        SetProp(rcu, "ProjectType", Enum.Parse(roboAsm.GetType("RoboExp.ProjectType"), "CodeApp"));
        SetProp(rcu, "CodeData", codeData);
        using (var fs = File.Create(rcuPath)) new BinaryFormatter().Serialize(fs, rcu);

        File.WriteAllText(Path.Combine(outDir, name + ".c"), code, Encoding.Default);
        // GUI always writes HardwareInfo.c next to the app; keep the pair complete
        string hw = Path.Combine(outDir, "HardwareInfo.c");
        if (!File.Exists(hw)) File.WriteAllText(hw, "", Encoding.Default);
        Console.WriteLine(ToJson(new Dictionary<string, object>
        {
            { "ok", true }, { "name", name }, { "rcu", rcuPath }, { "c", Path.Combine(outDir, name + ".c") },
            { "userDeps", LS(spec, "userDeps") },
        }));
        return 0;
    }

    static void AddToEventArrayList(object list, object item)
    {
        foreach (MethodInfo m in list.GetType().GetMethods())
            if (m.Name == "Add" && m.GetParameters().Length == 1)
            { m.Invoke(list, new[] { item }); return; }
        throw new Exception("EventArrayList has no Add(object) on " + list.GetType().FullName);
    }

    // ---------------- UserInclude.xml management ----------------
    static string UserIncludePath(string swType)
    {
        return Path.Combine(roboDir, "Robots", swType, "Resources", "UserInclude.xml");
    }

    static bool IsSystemFunc(string swType, string funcName)
    {
        string xml = Path.Combine(roboDir, "Robots", swType, "Include", "Include.xml");
        if (!File.Exists(xml)) return false;
        var doc = new XmlDocument(); doc.Load(xml);
        foreach (XmlNode n in doc.SelectNodes("//FuncName"))
            if (n.InnerText.Trim() == funcName) return true;
        return false;
    }

    static void RegisterRcu(string rcuPath, string swType, string band)
    {
        rcuPath = Path.GetFullPath(rcuPath);
        string path = UserIncludePath(swType);
        var doc = new XmlDocument();
        if (File.Exists(path)) { try { doc.Load(path); } catch { doc.LoadXml("<root/>"); } }
        else doc.LoadXml("<root/>");
        if (doc.DocumentElement == null) doc.LoadXml("<root/>");

        XmlElement bandEl = null;
        foreach (XmlElement b in doc.DocumentElement.SelectNodes("Band"))
            if (b.GetAttribute("Default") == band || b.GetAttribute("CHS") == band) { bandEl = b; break; }
        if (bandEl == null)
        {
            bandEl = doc.CreateElement("Band");
            bandEl.SetAttribute("Default", band);
            bandEl.SetAttribute("CHS", band);
            bandEl.SetAttribute("CHT", band);
            bandEl.SetAttribute("IsShow", "true");
            doc.DocumentElement.AppendChild(bandEl);
        }
        foreach (XmlElement fn in bandEl.SelectNodes("FuncName"))
            if (string.Compare(fn.InnerText.Trim(), rcuPath, StringComparison.OrdinalIgnoreCase) == 0) return; // already there
        XmlElement el = doc.CreateElement("FuncName");
        el.SetAttribute("IsSystem", "false");
        el.SetAttribute("IsShow", "true");
        el.InnerText = rcuPath;
        bandEl.AppendChild(el);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        using (var xw = new XmlTextWriter(path, null) { Formatting = Formatting.Indented, Indentation = 2 })
            doc.Save(xw);
    }

    static int CmdRegister(string rcuPath, string swType, string band)
    {
        RegisterRcu(rcuPath, swType, band);
        Console.WriteLine("OK registered " + rcuPath);
        return 0;
    }

    static int CmdUnregister(string rcuPath, string swType)
    {
        rcuPath = Path.GetFullPath(rcuPath);
        string path = UserIncludePath(swType);
        if (!File.Exists(path)) { Console.WriteLine("nothing to unregister"); return 0; }
        var doc = new XmlDocument(); doc.Load(path);
        bool changed = false;
        foreach (XmlElement bandEl in doc.DocumentElement.SelectNodes("Band").Cast<XmlElement>().ToList())
        {
            foreach (XmlElement fn in bandEl.SelectNodes("FuncName").Cast<XmlElement>().ToList())
                if (string.Compare(fn.InnerText.Trim(), rcuPath, StringComparison.OrdinalIgnoreCase) == 0)
                { bandEl.RemoveChild(fn); changed = true; }
            if (!bandEl.HasChildNodes) doc.DocumentElement.RemoveChild(bandEl);
        }
        if (changed) using (var xw = new XmlTextWriter(path, null) { Formatting = Formatting.Indented, Indentation = 2 }) doc.Save(xw);
        Console.WriteLine(changed ? "OK unregistered " + rcuPath : "not found");
        return 0;
    }

    static int CmdListLib(string swType)
    {
        string path = UserIncludePath(swType);
        var bands = new List<Dictionary<string, object>>();
        if (File.Exists(path))
        {
            var doc = new XmlDocument(); doc.Load(path);
            foreach (XmlElement bandEl in doc.SelectNodes("//Band"))
            {
                var mods = new List<Dictionary<string, object>>();
                foreach (XmlElement fn in bandEl.SelectNodes("FuncName"))
                    mods.Add(new Dictionary<string, object>
                    {
                        { "path", fn.InnerText },
                        { "name", Path.GetFileNameWithoutExtension(fn.InnerText) },
                        { "isSystem", fn.GetAttribute("IsSystem") == "true" },
                    });
                bands.Add(new Dictionary<string, object>
                {
                    { "band", bandEl.GetAttribute("CHS") },
                    { "modules", mods },
                });
            }
        }
        Console.WriteLine(ToJson(bands));
        return 0;
    }

    // ---------------- compile ----------------
    static int RunCompiler(string cFile, string mode, string swType, StringBuilder log)
    {
        string includeDir = Path.Combine(roboDir, "Robots", swType, "Include");
        string workDir = Path.GetDirectoryName(cFile);
        string exe = Path.Combine(roboDir, "Compiler", "JMCompiler.exe");
        string args = "\"" + cFile + "\" \"" + swType + "\" \"" + mode + "\" \"" + workDir + "\" \"" +
                      includeDir + "*" + workDir + "\" \"" + includeDir + "\"";
        var psi = new System.Diagnostics.ProcessStartInfo(exe, args)
        {
            WorkingDirectory = workDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.Default,
            StandardErrorEncoding = Encoding.Default,
        };
        using (var p = System.Diagnostics.Process.Start(psi))
        {
            string so = p.StandardOutput.ReadToEnd();
            string se = p.StandardError.ReadToEnd();
            p.WaitForExit();
            Console.Out.Write(so);
            Console.Error.Write(se);
            if (log != null) { log.Append(so); log.Append(se); }
            return p.ExitCode;
        }
    }

    static int CmdCompile(string cFile, string mode, string swType)
    {
        cFile = Path.GetFullPath(cFile);
        int rc = RunCompiler(cFile, mode, swType, null);
        // JMCompiler's exit code is unreliable; judge by artifacts instead
        if (mode == "main")
        {
            string bin = Path.ChangeExtension(cFile, ".bin");
            bool ok = File.Exists(bin) && File.GetLastWriteTime(bin) >= DateTime.Now.AddMinutes(-2);
            Console.WriteLine(ok ? "COMPILE OK -> " + bin : "COMPILE FAILED (no fresh .bin)");
            return ok ? 0 : 1;
        }
        Console.WriteLine(rc == 0 ? "COMPILE OK (func syntax check)" : "COMPILE FAILED (" + rc + ")");
        return rc;
    }

    // Full-link probe of one module: generate __probe__.c that #includes the module and
    // calls it from main(), compile in main mode (catches undefined references that the
    // func-mode syntax check misses), report a JSON verdict, then delete all probe artifacts.
    static int CmdCompileStrict(string cFile, string swType)
    {
        cFile = Path.GetFullPath(cFile);
        string name = Path.GetFileNameWithoutExtension(cFile);
        string content = File.ReadAllText(cFile, Encoding.Default);
        // signature sits at column 0 (global lines start with '#', body lines are indented)
        Match m = Regex.Match(content, @"^[A-Za-z_]\w*[ \t]+[A-Za-z_]\w*[ \t]*\(([^)]*)\)", RegexOptions.Multiline);
        if (!m.Success) { Console.Error.WriteLine("cannot find function signature in " + cFile); return 1; }
        string ps = m.Groups[1].Value.Trim();
        string argsList = ps.Length == 0 ? "" : string.Join(", ", Enumerable.Repeat("0", ps.Split(',').Length).ToArray());
        string workDir = Path.GetDirectoryName(cFile);
        string probe = Path.Combine(workDir, "__probe__.c");
        File.WriteAllText(probe,
            "#include \"" + name + ".c\"\r\n\r\nint main(void)\r\n{\r\n    " + name + "(" + argsList + ");\r\n    while(1);\r\n}\r\n",
            Encoding.Default);
        var log = new StringBuilder();
        bool ok = false;
        try
        {
            RunCompiler(probe, "main", swType, log);
            string bin = Path.ChangeExtension(probe, ".bin");
            ok = File.Exists(bin) && File.GetLastWriteTime(bin) >= DateTime.Now.AddMinutes(-2);
        }
        finally
        {
            foreach (string f in Directory.GetFiles(workDir, "__probe__.*"))
                try { File.Delete(f); } catch { }
        }
        Console.WriteLine(ToJson(new Dictionary<string, object>
        {
            { "ok", ok }, { "module", name }, { "c", cFile }, { "log", log.ToString() },
        }));
        return ok ? 0 : 1;
    }

    // ---------------- apis ----------------
    static string Attr(XmlElement e, string child, string name)
    {
        XmlElement c = e.SelectSingleNode(child) as XmlElement;
        return c == null ? "" : c.GetAttribute(name);
    }

    static int CmdApis(string swType, string filter)
    {
        string xml = Path.Combine(roboDir, "Robots", swType, "Include", "JMlib.xml");
        var doc = new XmlDocument(); doc.Load(xml);
        var list = new List<Dictionary<string, object>>();
        foreach (XmlElement func in doc.SelectNodes("//Func"))
        {
            XmlNode nameNode = func.SelectSingleNode("Name");
            if (nameNode == null) continue;
            string n = nameNode.InnerText.Trim();
            if (filter != null && filter.Length > 0 && n.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
            string cap = Attr(func, "Caption", "CHS");
            if (cap == "") cap = Attr(func, "Caption", "Default");
            string des = Attr(func, "Description", "CHS");
            if (des == "") des = Attr(func, "Description", "Default");
            var ps = new List<Dictionary<string, object>>();
            foreach (XmlElement p in func.SelectNodes("Param"))
            {
                string pd = Txt(p, "DesCHS");
                if (pd == "") pd = Txt(p, "DesDefault");
                ps.Add(new Dictionary<string, object>
                {
                    { "type", Txt(p, "Type") }, { "name", Txt(p, "Name") },
                    { "min", Txt(p, "Min") }, { "max", Txt(p, "Max") }, { "default", Txt(p, "Default") },
                    { "desc", pd },
                });
            }
            list.Add(new Dictionary<string, object>
            {
                { "name", n }, { "returnType", Txt(func, "ReturnType") },
                { "caption", cap }, { "description", des },
                { "params", ps }, { "icon", "system:" + n },
            });
        }
        Console.WriteLine(ToJson(list));
        return 0;
    }

    static string Txt(XmlElement e, string child)
    {
        XmlNode n = e.SelectSingleNode(child);
        return n != null ? n.InnerText.Trim() : "";
    }

    // ---------------- info (read a .rcu's metadata as JSON) ----------------
    static Dictionary<string, object> BuildInfo(string rcuPath)
    {
        object rcu;
        using (var fs = File.OpenRead(rcuPath)) rcu = new BinaryFormatter().Deserialize(fs);
        string ptName = GetProp(rcu, "ProjectType").ToString();
        object data = GetProp(rcu, "CodeData") ?? GetProp(rcu, "FlowData");
        object pd = GetProp(data, "ProjectData");
        object pi = GetProp(pd, "ProjectInfo");
        object rt = GF(pi, "m_ReturnType");
        var o = new Dictionary<string, object>
        {
            { "path", Path.GetFullPath(rcuPath) },
            { "projectType", ptName },
            { "name", GF(pi, "m_ProjectName") },
            { "caption", GF(pi, "m_ProjectCaption") },
            { "description", GF(pi, "m_ProjectDescription") },
            { "returnType", GF(rt, "m_Type") },
            { "version", GF(pi, "m_UserVersion") },
            { "author", GF(pi, "m_UserName") },
            { "params", new List<Dictionary<string, object>>() },
            { "userDeps", new List<string>() },
            { "global", GF(GF(pd, "m_CodeFrameData"), "m_Global") as string ?? "" },
            { "code", GF(GF(pd, "m_CodeFrameData"), "m_Code") as string ?? "" },
        };
        foreach (object p in (IEnumerable)GF(pi, "m_ParamList"))
            ((List<Dictionary<string, object>>)o["params"]).Add(new Dictionary<string, object>
            {
                { "name", GF(p, "m_Name") }, { "type", GF(p, "m_Type") },
                { "default", GF(p, "m_DefaultValue") }, { "min", GF(p, "m_Min") }, { "max", GF(p, "m_Max") },
                { "desc", GF(p, "m_Description") }, { "isHardware", GF(p, "m_IsHardwareType") },
            });
        foreach (object u in (IEnumerable)GF(pd, "m_UsedProjectInfoList"))
            ((List<string>)o["userDeps"]).Add((string)GF(u, "m_ProjectName"));
        return o;
    }

    static int CmdInfo(string rcuPath)
    {
        Console.WriteLine(ToJson(BuildInfo(rcuPath)));
        return 0;
    }

    // Index a LOCAL third-party competition platform folder: one pass over its .rcu files,
    // returning the same catalog shape as info. Nothing is copied or bundled — this only
    // reads the copy already on the user's disk.
    static int CmdKbIndex(string dir)
    {
        dir = Path.GetFullPath(dir);
        if (!Directory.Exists(dir)) { Console.Error.WriteLine("dir not found: " + dir); return 1; }
        var list = new List<Dictionary<string, object>>();
        foreach (string f in Directory.GetFiles(dir, "*.rcu"))
        {
            try { list.Add(BuildInfo(f)); }
            catch (Exception ex) { Console.Error.WriteLine("WARN skip " + Path.GetFileName(f) + ": " + ex.Message); }
        }
        Console.WriteLine(ToJson(list));
        return 0;
    }

    // Extract plain text from a LOCAL .docx (word/document.xml) — used to read the
    // third-party platform's own manuals at runtime without redistributing them.
    static int CmdDocxText(string file)
    {
        if (!File.Exists(file)) { Console.Error.WriteLine("file not found: " + file); return 1; }
        var sb = new StringBuilder();
        using (var zip = System.IO.Compression.ZipFile.OpenRead(file))
        {
            var entry = zip.GetEntry("word/document.xml");
            if (entry == null) { Console.Error.WriteLine("not a docx: " + file); return 1; }
            using (var sr = new StreamReader(entry.Open(), Encoding.UTF8))
            {
                string xml = sr.ReadToEnd();
                foreach (string para in xml.Split(new[] { "</w:p>" }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var texts = new StringBuilder();
                    foreach (Match m in Regex.Matches(para, "<w:t[^>]*>([^<]*)</w:t>"))
                        texts.Append(System.Web.HttpUtility.HtmlDecode(m.Groups[1].Value));
                    string line = texts.ToString().Trim();
                    if (line.Length > 0) sb.AppendLine(line);
                }
            }
        }
        Console.WriteLine(ToJson(new Dictionary<string, object> { { "file", Path.GetFullPath(file) }, { "text", sb.ToString() } }));
        return 0;
    }
}
