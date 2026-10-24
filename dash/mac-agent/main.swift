// XboxDashAgent — runs in the Mac GUI session (LaunchAgent), pushes Calendar + HomeKit snapshots to
// the dashboard server (dash/server) and executes queued Home commands. The server never pulls from the Mac.
//
// Config: ~/.config/xbox-dash-agent.json  {"server": "http://<server-lan-ip>:8098", "token": "<DASH_PUSH_TOKEN>"}
import AppKit
import EventKit
import Foundation

struct Config: Decodable { let server: String; let token: String }

let cfgURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/xbox-dash-agent.json")
guard let cfgData = try? Data(contentsOf: cfgURL), let cfg = try? JSONDecoder().decode(Config.self, from: cfgData) else {
    FileHandle.standardError.write("missing/invalid \(cfgURL.path)\n".data(using: .utf8)!)
    exit(1)
}
let homeclaw = "/Applications/HomeClaw.app/Contents/MacOS/homeclaw-cli"
let store = EKEventStore()
let work = DispatchQueue(label: "agent")

func log(_ s: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    print("\(ts) \(s)")
    fflush(stdout)
}

// ---------------------------------------------------------------- http
@discardableResult
func request(_ path: String, method: String = "GET", body: Any? = nil) -> Data? {
    var req = URLRequest(url: URL(string: cfg.server + path)!, timeoutInterval: 15)
    req.httpMethod = method
    req.setValue("Bearer \(cfg.token)", forHTTPHeaderField: "Authorization")
    if let body {
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let sem = DispatchSemaphore(value: 0)
    var out: Data?
    URLSession.shared.dataTask(with: req) { data, resp, err in
        if let err { log("http \(path): \(err.localizedDescription)") }
        else if let h = resp as? HTTPURLResponse, h.statusCode >= 300 { log("http \(path): \(h.statusCode)") }
        else { out = data }
        sem.signal()
    }.resume()
    sem.wait()
    return out
}

// ---------------------------------------------------------------- calendar
func hex(_ c: CGColor?) -> String? {
    guard let c, let n = NSColor(cgColor: c)?.usingColorSpace(.sRGB) else { return nil }
    return String(format: "#%02X%02X%02X", Int(n.redComponent * 255), Int(n.greenComponent * 255), Int(n.blueComponent * 255))
}

let meetRx = try! NSRegularExpression(pattern: #"https://(?:[\w-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|facetime\.apple\.com)/[^\s<>"')]+"#)
func meetingURL(_ e: EKEvent) -> String? {
    if let u = e.url?.absoluteString, meetRx.firstMatch(in: u, range: NSRange(u.startIndex..., in: u)) != nil { return u }
    for text in [e.location, e.notes].compactMap({ $0 }) {
        if let m = meetRx.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let r = Range(m.range, in: text) {
            return String(text[r])
        }
    }
    return nil
}

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = .current
    return f
}()

func pushCalendar() {
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
        log("calendar: no full access (status \(EKEventStore.authorizationStatus(for: .event).rawValue))")
        return
    }
    let start = Calendar.current.startOfDay(for: Date())
    let end = Calendar.current.date(byAdding: .day, value: 8, to: start)!
    let skip: Set<String> = ["Siri Suggestions"]
    let cals = store.calendars(for: .event).filter { !skip.contains($0.title) }
    let evs = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: cals))
    let out: [[String: Any]] = evs.map { e in
        var d: [String: Any] = [
            "title": e.title ?? "(no title)", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate),
            "calendar": e.calendar.title, "source": e.calendar.source?.title ?? "", "allDay": e.isAllDay,
        ]
        if let c = hex(e.calendar.cgColor) { d["color"] = c }
        if let u = meetingURL(e) { d["url"] = u }
        if let l = e.location, !l.isEmpty, !l.hasPrefix("http") { d["location"] = l }
        return d
    }
    if request("/api/push/calendar", method: "POST", body: ["events": out]) != nil { log("calendar: pushed \(out.count) events") }
}

// ---------------------------------------------------------------- home
func run(_ args: [String]) -> Data? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: homeclaw)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = Pipe()
    do { try p.run() } catch { log("homeclaw: \(error)"); return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 ? data : nil
}

func ensureHomeClaw() {
    if !NSWorkspace.shared.runningApplications.contains(where: { $0.executableURL?.path.contains("HomeClaw.app") == true }) {
        log("starting HomeClaw")
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/Applications/HomeClaw.app"), configuration: .init())
        Thread.sleep(forTimeInterval: 5)
    }
}

func pushHome() {
    ensureHomeClaw()
    guard let acc = run(["list", "--json"]), let sc = run(["scenes", "--json"]),
          let a = try? JSONSerialization.jsonObject(with: acc), let s = try? JSONSerialization.jsonObject(with: sc) else {
        log("home: homeclaw-cli failed")
        return
    }
    if request("/api/push/home", method: "POST", body: ["accessories": a, "scenes": s]) != nil { log("home: pushed") }
}

func runCommands() {
    guard let d = request("/api/home/commands"), let cmds = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], !cmds.isEmpty else { return }
    for c in cmds {
        let op = c["op"] as? String
        var args: [String]?
        if op == "trigger", let s = c["scene"] as? String { args = ["trigger", s] }
        if op == "set", let id = c["id"] as? String, let ch = c["characteristic"] as? String, let v = c["value"] {
            args = ["set", id, ch, "\(v)"]
        }
        guard let args else { log("cmd: ignored \(c)"); continue }
        log("cmd: \(args.joined(separator: " ")) -> \(run(args) != nil ? "ok" : "FAILED")")
    }
    Thread.sleep(forTimeInterval: 1)
    pushHome()
}

// ---------------------------------------------------------------- main
NSApplication.shared.setActivationPolicy(.accessory)
log("XboxDashAgent start, server \(cfg.server)")

store.requestFullAccessToEvents { granted, err in
    log("calendar access: \(granted) \(err?.localizedDescription ?? "")")
    work.async { pushCalendar() }
}
NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: nil) { _ in
    work.async { pushCalendar() }
}

var tick = 0
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
    tick += 1
    work.async {
        runCommands()
        if tick % 15 == 1 { pushHome() } // every 30 s
        if tick % 30 == 0 { pushCalendar() } // every 60 s
    }
}
NSApplication.shared.run()
