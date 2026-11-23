// Offline reader for the bounded Kernel-File ETL. Layouts are the provider manifest's
// NameCreate/NameDelete v0, Create/Read/Write v0/v1 and OperationEnd v0 (not classic NT Kernel Logger layouts).
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <evntcons.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace {
using Tick = int64_t;
constexpr Tick unixEpoch = 116444736000000000LL;
constexpr GUID provider = {0xedd08927, 0x9cc4, 0x4e65, {0xb9,0x70,0xc2,0x56,0x0f,0xb5,0xc2,0x89}};
const std::array<std::wstring_view,4> suffix = {L"\\Network\\Cookies", L"\\Network\\Cookies-journal", L"\\Network\\Cookies-wal", L"\\Network\\Cookies-shm"};
const char* const kinds[] = {"db", "journal", "wal", "shm"};
Tick epochMs(Tick t) { return (t - unixEpoch) / 10000; }
bool same(std::wstring_view a, std::wstring_view b) {
    return a.size() == b.size() && CompareStringOrdinal(a.data(), int(a.size()), b.data(), int(b.size()), TRUE) == CSTR_EQUAL;
}
struct PathLess {
    using is_transparent = void;
    bool operator()(std::wstring_view a, std::wstring_view b) const {
        return CompareStringOrdinal(a.data(), int(a.size()), b.data(), int(b.size()), TRUE) == CSTR_LESS_THAN;
    }
};
struct Host {
    uint32_t pid;
    Tick lifetime;
    std::wstring dos, nt;
    bool shared = false;
    unsigned observed = 0;
    std::map<std::wstring, unsigned, PathLess> files;
};
struct File { Host* host; unsigned id, kind; };
struct Operation { File file; Tick at; uint32_t pid, tid; unsigned event; uint32_t size; };
struct Payload {
    const unsigned char* data;
    size_t bytes, width;
    template<typename T> T take() {
        if (bytes < sizeof(T)) throw std::runtime_error("schema");
        T value;
        std::memcpy(&value, data, sizeof(T));
        data += sizeof(T); bytes -= sizeof(T);
        return value;
    }
    uint64_t pointer() { return width == 4 ? take<uint32_t>() : take<uint64_t>(); }
    std::wstring_view name() const {
        if (bytes < 2 || bytes % 2 || data[bytes-1] || data[bytes-2]) throw std::runtime_error("name");
        return {reinterpret_cast<const wchar_t*>(data), bytes / 2 - 1};
    }
};
struct Reader {
    std::vector<Host> hosts;
    std::unordered_map<uint64_t,File> names;
    std::unordered_map<uint64_t,Operation> pending;
    std::ofstream out{"nav-cookie-io.jsonl", std::ios::binary};
    unsigned rows = 0, omitted = 0, named = 0;
    std::array<unsigned,25> counts{};
    Tick first = 0, last = 0;
    bool lost = false, invalid = false;

    std::optional<File> match(std::wstring_view path, Tick at) {
        unsigned k = 0;
        for (; k < suffix.size(); ++k) {
            if (path.size() > suffix[k].size() && same(path.substr(path.size()-suffix[k].size()), suffix[k])) break;
        }
        if (k == suffix.size() || path.find(L"\\..\\") != path.npos || path.find(L"\\.\\") != path.npos || path.find(L'\0') != path.npos) return {};
        if (path.substr(0,4) == L"\\??\\" || path.substr(0,4) == L"\\\\?\\") path.remove_prefix(4);
        for (auto& host : hosts) {
            if (host.shared || epochMs(at) < host.lifetime) continue;
            for (const auto* root : {&host.nt, &host.dos}) {
                if (root->empty() || path.size() <= root->size() || !same(path.substr(0, root->size()), *root)) continue;
                auto relative = path.substr(root->size());
                if (relative.find(L':') != relative.npos) continue;
                auto it = host.files.find(relative);
                if (it == host.files.end()) it = host.files.emplace(relative, unsigned(host.files.size()+1)).first;
                return File{&host, it->second, k};
            }
        }
        return {};
    }

    void emit(const Operation& op, Tick end = 0, uint32_t status = 0, uint64_t info = 0) {
        ++op.file.host->observed;
        if (rows == 50000) { ++omitted; return; }
        ++rows;
        const char* action = op.event == 15 ? "read" : op.event == 16 ? "write" : "create/open";
        if (op.event == 12 && end && status == 0) {
            if (info == 1) action = "open";  // IO_STATUS_BLOCK.Information: FILE_OPENED or FILE_CREATED.
            if (info == 2) action = "create";
        }
        out << "{\"event\":\"cookie-io.operation\",\"hostPid\":" << op.file.host->pid << ",\"lifetime\":" << op.file.host->lifetime
            << ",\"file\":\"" << kinds[op.file.kind] << "\",\"fileId\":" << op.file.id << ",\"operation\":\"" << action
            << "\",\"pid\":" << op.pid << ",\"issuingTid\":";
        if (op.tid) out << op.tid; else out << "null";
        out << ",\"startMs\":" << epochMs(op.at) << ",\"requestedBytes\":";
        if (op.event == 12) out << "null"; else out << op.size;
        if (end) out << ",\"ntStatus\":" << status << ",\"endMs\":" << epochMs(end) << ",\"elapsedUs\":" << (end-op.at)/10;
        else out << ",\"ntStatus\":null,\"endMs\":null,\"elapsedUs\":null";
        out << "}\n";
    }

    void accept(const EVENT_RECORD& r) {
        const auto& h = r.EventHeader;
        if (!IsEqualGUID(h.ProviderId, provider)) return;
        const unsigned id = h.EventDescriptor.Id, v = h.EventDescriptor.Version;
        if (id != 10 && id != 11 && id != 12 && id != 15 && id != 16 && id != 24) return;
        ++counts[id];
        const Tick at = h.TimeStamp.QuadPart;
        if (!first) first = at;
        if (at < last || v > ((id == 12 || id == 15 || id == 16) ? 1u : 0u)) throw std::runtime_error("order/schema");
        last = at;
        Payload p{static_cast<const unsigned char*>(r.UserData), r.UserDataLength, (h.Flags & EVENT_HEADER_FLAG_32_BIT_HEADER) ? 4u : 8u};
        if (id == 10 || id == 11) {
            const auto key = p.pointer();
            names.erase(key);
            if (!lost && key && id == 10) if (auto f = match(p.name(), at)) { names.emplace(key, *f); ++named; }
            return;
        }
        if (id == 15 || id == 16) p.take<uint64_t>(); // ByteOffset
        const auto irp = p.pointer();
        auto it = pending.find(irp);
        if (id == 24) {
            if (it != pending.end()) {
                const auto info = p.pointer();
                emit(it->second, at, p.take<uint32_t>(), info);
                pending.erase(it);
            }
            return;
        }
        // A new start with the same IRP invalidates a missing end, even for an unrelated path.
        if (it != pending.end()) { emit(it->second); pending.erase(it); }
        const uint64_t oldTid = v == 0 ? p.pointer() : 0;
        uint32_t tid = oldTid <= UINT32_MAX ? uint32_t(oldTid) : 0;
        p.pointer(); // FileObject
        std::optional<File> file;
        uint32_t size = 0;
        if (id == 12) {
            if (v == 1) tid = p.take<uint32_t>();
            p.take<uint32_t>(); p.take<uint32_t>(); p.take<uint32_t>(); // options, attributes, share access
            file = match(p.name(), at);
        } else {
            auto name = names.find(p.pointer()); // FileKey lives from NameCreate to NameDelete.
            if (name == names.end()) return;
            file = name->second;
            if (v == 1) tid = p.take<uint32_t>();
            size = p.take<uint32_t>();
        }
        if (!file) return;
        Operation op{*file, at, h.ProcessId, tid, id, size};
        if (irp && !lost) pending.emplace(irp, op); else emit(op);
    }
};
void WINAPI onRecord(EVENT_RECORD* r) {
    auto& reader = *static_cast<Reader*>(r->UserContext);
    if (reader.invalid) return;
    try { reader.accept(*r); } catch (...) { reader.invalid = true; }
}
}

int main() {
    auto env = [](const char* key) -> std::string_view { const char* s = std::getenv(key); return s ? s : ""; };
    if (env("RUNNER_ENVIRONMENT") != "github-hosted" || env("GITHUB_ACTIONS") != "true" || env("OMPDESK_NAV_PRIVATE").empty() || env("OMPDESK_NAV_STAGES").empty()) return 1;
    // Check the path boundary against invented names, without opening any profile.
    Reader reader;
    reader.hosts.push_back({1, 1, L"C:\\test\\tauri-webview\\", L"\\Device\\Test\\test\\tauri-webview\\"});
    const auto synthetic = reader.match(L"\\Device\\Test\\test\\tauri-webview\\Default\\Network\\Cookies-shm", unixEpoch + 10000);
    if (!synthetic || synthetic->kind != 3 ||
        reader.match(L"C:\\test\\tauri-webview-other\\Default\\Network\\Cookies", unixEpoch + 10000) ||
        reader.match(L"C:\\test\\tauri-webview\\..\\Default\\Network\\Cookies", unixEpoch + 10000) ||
        reader.match(L"C:\\test\\tauri-webview\\Default\\Network\\Cookies.tmp", unixEpoch + 10000)) return 2;
    reader.hosts.clear();
    std::ifstream roots("nav-cookie-io.roots", std::ios::binary);
    if (!roots || !reader.out) return 2;
    for (std::string line; std::getline(roots, line);) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        auto a = line.find('\t'), b = line.find('\t', a+1);
        if (a == line.npos || b == line.npos) return 2;
        Host host{uint32_t(std::stoul(line.substr(0,a))), std::stoll(line.substr(a+1,b-a-1))};
        if (b+1 < line.size()) {
            host.dos = std::filesystem::u8path(line.substr(b+1)).wstring() + L"\\tauri-webview\\";
            wchar_t device[1024];
            if (!QueryDosDeviceW(host.dos.substr(0,2).c_str(), device, 1024)) return 2;
            host.nt = device + host.dos.substr(2);
            // Several launches can intentionally reuse one profile. Never guess which owns an I/O.
            for (auto& other : reader.hosts) if (same(host.nt, other.nt)) host.shared = other.shared = true;
        }
        reader.hosts.push_back(std::move(host));
    }
    wchar_t etl[MAX_PATH];
    DWORD len = GetFullPathNameW(L"nav-cookie-io.etl", MAX_PATH, etl, nullptr);
    if (!len || len >= MAX_PATH) return 3;
    EVENT_TRACE_LOGFILEW log{};
    log.LogFileName = etl;
    log.ProcessTraceMode = PROCESS_TRACE_MODE_EVENT_RECORD;
    log.EventRecordCallback = onRecord;
    log.Context = &reader;
    auto trace = OpenTraceW(&log);
    if (trace == INVALID_PROCESSTRACE_HANDLE) return 3;
    const auto& hdr = log.LogfileHeader;
    reader.lost = hdr.EventsLost || hdr.BuffersLost || !hdr.EndTime.QuadPart;
    auto status = ProcessTrace(&trace, 1, nullptr, nullptr);
    CloseTrace(trace);
    if (status != ERROR_SUCCESS || reader.invalid) {
        reader.out.close();
        reader.out.open("nav-cookie-io.jsonl", std::ios::binary | std::ios::trunc);
        reader.out << "{\"event\":\"cookie-io.unavailable\",\"phase\":\"event-stream\",\"etwStatus\":" << status
            << ",\"invalidSchemaOrOrder\":" << (reader.invalid ? "true" : "false") << ",\"eventsLost\":" << hdr.EventsLost
            << ",\"buffersLost\":" << hdr.BuffersLost << "}\n";
        reader.out.close();
        return reader.out ? 0 : 4;
    }
    for (const auto& op : reader.pending) reader.emit(op.second);
    for (const auto& host : reader.hosts) {
        const char* state = host.dos.empty() ? "missing-profile" : host.shared ? "shared-profile" :
            host.observed ? "observed" : !reader.last ? "empty-provider" :
            host.lifetime > epochMs(reader.last) ? "outside-window" : "no-events";
        reader.out << "{\"event\":\"cookie-io.host\",\"hostPid\":" << host.pid << ",\"lifetime\":" << host.lifetime
            << ",\"state\":\"" << state << "\",\"operations\":" << host.observed << "}\n";
    }
    reader.out << "{\"event\":\"cookie-io.summary\",\"hosts\":" << reader.hosts.size() << ",\"eventsLost\":" << hdr.EventsLost
        << ",\"buffersLost\":" << hdr.BuffersLost << ",\"indirectJoinsEnabled\":" << (reader.lost ? "false" : "true")
        << ",\"firstProviderMs\":" << (reader.first ? std::to_string(epochMs(reader.first)) : "null")
        << ",\"lastProviderMs\":" << (reader.last ? std::to_string(epochMs(reader.last)) : "null") << ",\"matchedNames\":" << reader.named
        << ",\"creates\":" << reader.counts[12] << ",\"reads\":" << reader.counts[15] << ",\"writes\":" << reader.counts[16]
        << ",\"ends\":" << reader.counts[24] << ",\"rows\":" << reader.rows << ",\"omittedRows\":" << reader.omitted << "}\n";
    reader.out.close();
    return reader.out ? 0 : 5;
}
