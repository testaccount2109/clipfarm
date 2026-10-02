#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>

#include <atomic>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")

namespace {
constexpr unsigned int kSampleRate = 48000;
constexpr unsigned int kChannels = 2;
std::atomic<bool> g_stop{false};
std::atomic<float> g_microphoneGain{1.0f};

std::string ToUtf8(const wchar_t* value) {
  if (!value) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), size, nullptr, nullptr);
  result.pop_back();
  return result;
}

std::string JsonEscape(const std::string& value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (const unsigned char character : value) {
    switch (character) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (character < 0x20) {
          char escaped[7]{};
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", character);
          result += escaped;
        } else result += static_cast<char>(character);
    }
  }
  return result;
}

std::string EndpointId(IMMDevice* device) {
  LPWSTR id = nullptr;
  if (FAILED(device->GetId(&id)) || !id) return {};
  std::string result = ToUtf8(id);
  CoTaskMemFree(id);
  return result;
}

std::string EndpointName(IMMDevice* device) {
  IPropertyStore* store = nullptr;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &store)) || !store) return "Windows-Audiogerät";
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string result = "Windows-Audiogerät";
  if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR) {
    const std::string candidate = ToUtf8(value.pwszVal);
    if (!candidate.empty()) result = candidate;
  }
  PropVariantClear(&value);
  store->Release();
  return result;
}

HRESULT CreateEnumerator(IMMDeviceEnumerator** enumerator) {
  return CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator));
}

bool GetDefaultEndpointId(EDataFlow flow, std::string& id) {
  IMMDeviceEnumerator* enumerator = nullptr;
  if (FAILED(CreateEnumerator(&enumerator))) return false;
  IMMDevice* device = nullptr;
  HRESULT result = enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device);
  if (FAILED(result)) result = enumerator->GetDefaultAudioEndpoint(flow, eMultimedia, &device);
  if (SUCCEEDED(result) && device) id = EndpointId(device);
  if (device) device->Release();
  enumerator->Release();
  return !id.empty();
}

int ListMicrophones() {
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) return 2;

  std::string defaultId;
  GetDefaultEndpointId(eCapture, defaultId);

  IMMDeviceEnumerator* enumerator = nullptr;
  if (FAILED(CreateEnumerator(&enumerator))) {
    CoUninitialize();
    return 2;
  }
  IMMDeviceCollection* collection = nullptr;
  if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection))) {
    enumerator->Release();
    CoUninitialize();
    return 2;
  }

  UINT count = 0;
  collection->GetCount(&count);
  std::cout << "{\"default\":\"" << JsonEscape(defaultId) << "\",\"devices\":[";
  bool first = true;
  for (UINT index = 0; index < count; ++index) {
    IMMDevice* device = nullptr;
    if (FAILED(collection->Item(index, &device)) || !device) continue;
    const std::string id = EndpointId(device);
    const std::string name = EndpointName(device);
    if (!id.empty()) {
      if (!first) std::cout << ',';
      first = false;
      std::cout << "{\"id\":\"" << JsonEscape(id) << "\",\"name\":\"" << JsonEscape(name)
                << "\",\"isDefault\":" << (id == defaultId ? "true" : "false") << '}';
    }
    device->Release();
  }
  std::cout << "]}\n";

  collection->Release();
  enumerator->Release();
  CoUninitialize();
  return 0;
}

SOCKET ConnectLoopback(unsigned short port) {
  while (!g_stop.load()) {
    SOCKET socketHandle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socketHandle == INVALID_SOCKET) return INVALID_SOCKET;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    InetPtonA(AF_INET, "127.0.0.1", &address.sin_addr);
    if (connect(socketHandle, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0) return socketHandle;
    closesocket(socketHandle);
    Sleep(150);
  }
  return INVALID_SOCKET;
}

bool SendAll(SOCKET socketHandle, const char* data, size_t size) {
  size_t offset = 0;
  while (offset < size && !g_stop.load()) {
    const int sent = send(socketHandle, data + offset,
                          static_cast<int>((std::min)(size - offset, static_cast<size_t>(INT_MAX))), 0);
    if (sent <= 0) return false;
    offset += static_cast<size_t>(sent);
  }
  return offset == size;
}

struct WorkerState {
  std::atomic<int> status{0}; // 0 starting, 1 ready, -1 failed
  std::string error;
};

void CaptureEndpoint(unsigned short port, bool loopback, std::string deviceId, WorkerState* worker) {
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) {
    worker->error = "COM-Initialisierung ist fehlgeschlagen";
    worker->status.store(-1);
    return;
  }

  IMMDeviceEnumerator* enumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  HANDLE eventHandle = nullptr;
  SOCKET socketHandle = INVALID_SOCKET;
  auto cleanup = [&]() {
    g_stop.store(true);
    if (socketHandle != INVALID_SOCKET) { shutdown(socketHandle, SD_BOTH); closesocket(socketHandle); }
    if (capture) capture->Release();
    if (client) { client->Stop(); client->Release(); }
    if (device) device->Release();
    if (enumerator) enumerator->Release();
    if (eventHandle) CloseHandle(eventHandle);
    CoUninitialize();
  };

  HRESULT result = CreateEnumerator(&enumerator);
  if (FAILED(result)) {
    worker->error = "Windows-Audio konnte nicht initialisiert werden";
    worker->status.store(-1);
    cleanup();
    return;
  }
  if (loopback) {
    result = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(result)) result = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device);
  } else if (deviceId.empty() || deviceId == "default") {
    result = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
    if (FAILED(result)) result = enumerator->GetDefaultAudioEndpoint(eCapture, eMultimedia, &device);
  } else {
    const int wideSize = MultiByteToWideChar(CP_UTF8, 0, deviceId.c_str(), -1, nullptr, 0);
    std::wstring wideId(static_cast<size_t>((std::max)(wideSize, 1)), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, deviceId.c_str(), -1, wideId.data(), wideSize);
    result = enumerator->GetDevice(wideId.c_str(), &device);
  }
  if (FAILED(result) || !device) {
    worker->error = loopback ? "Windows-Standardausgabe konnte nicht geöffnet werden" : "Mikrofon konnte nicht geöffnet werden";
    worker->status.store(-1);
    cleanup();
    return;
  }
  result = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client));
  if (FAILED(result) || !client) {
    worker->error = loopback ? "Systemaudio konnte nicht gestartet werden" : "Mikrofon konnte nicht gestartet werden";
    worker->status.store(-1);
    cleanup();
    return;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(kChannels * sizeof(float));
  format.nAvgBytesPerSec = kSampleRate * format.nBlockAlign;
  DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  if (loopback) flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
  result = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, &format, nullptr);
  if (FAILED(result)) {
    worker->error = loopback ? "Windows konnte die Systemaudio-Loopbackspur nicht öffnen" : "Windows konnte das Mikrofonformat nicht öffnen";
    worker->status.store(-1);
    cleanup();
    return;
  }
  eventHandle = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!eventHandle || FAILED(client->SetEventHandle(eventHandle)) ||
      FAILED(client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture)))) {
    worker->error = loopback ? "Systemaudio-Capture konnte nicht bereitgestellt werden" : "Mikrofon-Capture konnte nicht bereitgestellt werden";
    worker->status.store(-1);
    cleanup();
    return;
  }
  result = client->Start();
  if (FAILED(result)) {
    worker->error = loopback ? "Systemaudio-Capture konnte nicht gestartet werden" : "Mikrofon-Capture konnte nicht gestartet werden";
    worker->status.store(-1);
    cleanup();
    return;
  }
  socketHandle = ConnectLoopback(port);
  if (socketHandle == INVALID_SOCKET) {
    worker->error = "Audioverbindung zum Clip-Puffer konnte nicht geöffnet werden";
    worker->status.store(-1);
    cleanup();
    return;
  }
  worker->status.store(1);

  std::vector<float> adjusted;
  if (!loopback) adjusted.reserve(kSampleRate * kChannels);
  while (!g_stop.load()) {
    const DWORD waitResult = WaitForSingleObject(eventHandle, 1000);
    if (waitResult == WAIT_FAILED) break;
    UINT32 packetFrames = 0;
    if (FAILED(capture->GetNextPacketSize(&packetFrames))) break;
    while (packetFrames > 0 && !g_stop.load()) {
      BYTE* buffer = nullptr;
      UINT32 frames = 0;
      DWORD bufferFlags = 0;
      if (FAILED(capture->GetBuffer(&buffer, &frames, &bufferFlags, nullptr, nullptr))) break;
      const size_t floatCount = static_cast<size_t>(frames) * kChannels;
      bool sent = true;
      if (bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) {
        static const std::vector<float> silence(kSampleRate * kChannels, 0.0f);
        size_t remaining = floatCount;
        while (remaining > 0) {
          const size_t count = (std::min)(remaining, silence.size());
          sent = SendAll(socketHandle, reinterpret_cast<const char*>(silence.data()), count * sizeof(float));
          if (!sent) break;
          remaining -= count;
        }
      } else if (!loopback) {
        const float gain = (std::max)(0.0f, (std::min)(2.0f, g_microphoneGain.load()));
        adjusted.resize(floatCount);
        const float* source = reinterpret_cast<const float*>(buffer);
        for (size_t index = 0; index < floatCount; ++index) adjusted[index] = (std::max)(-1.0f, (std::min)(1.0f, source[index] * gain));
        sent = SendAll(socketHandle, reinterpret_cast<const char*>(adjusted.data()), adjusted.size() * sizeof(float));
      } else {
        sent = SendAll(socketHandle, reinterpret_cast<const char*>(buffer), floatCount * sizeof(float));
      }
      capture->ReleaseBuffer(frames);
      if (!sent) { g_stop.store(true); break; }
      if (FAILED(capture->GetNextPacketSize(&packetFrames))) { g_stop.store(true); break; }
    }
  }
  cleanup();
}

int Capture(int systemPort, int microphonePort, const std::string& microphoneId, float initialGain) {
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) return 2;
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) { CoUninitialize(); return 2; }
  g_microphoneGain.store((std::max)(0.0f, (std::min)(2.0f, initialGain)));

  WorkerState systemWorker;
  WorkerState microphoneWorker;
  std::thread systemThread;
  std::thread microphoneThread;
  int workers = 0;
  if (systemPort > 0) {
    systemThread = std::thread(CaptureEndpoint, static_cast<unsigned short>(systemPort), true, std::string{}, &systemWorker);
    ++workers;
  } else systemWorker.status.store(1);
  if (microphonePort > 0) {
    microphoneThread = std::thread(CaptureEndpoint, static_cast<unsigned short>(microphonePort), false, microphoneId, &microphoneWorker);
    ++workers;
  } else microphoneWorker.status.store(1);

  bool ready = false;
  while (!g_stop.load()) {
    if (systemWorker.status.load() < 0 || microphoneWorker.status.load() < 0) break;
    if (systemWorker.status.load() == 1 && microphoneWorker.status.load() == 1) { ready = true; break; }
    Sleep(20);
  }
  if (!ready) {
    const std::string error = !systemWorker.error.empty() ? systemWorker.error : microphoneWorker.error;
    std::cerr << "ERROR " << (error.empty() ? "Windows-Audio konnte nicht gestartet werden" : error) << '\n';
    g_stop.store(true);
  } else {
    std::cout << "READY\n" << std::flush;
    std::string command;
    while (std::getline(std::cin, command)) {
      if (command.rfind("gain ", 0) == 0) {
        try {
          const float gain = std::stof(command.substr(5));
          g_microphoneGain.store((std::max)(0.0f, (std::min)(2.0f, gain)));
        } catch (...) { /* Ignore malformed control input. */ }
      }
    }
    g_stop.store(true);
  }

  if (systemThread.joinable()) systemThread.join();
  if (microphoneThread.joinable()) microphoneThread.join();
  WSACleanup();
  CoUninitialize();
  return ready ? 0 : 3;
}
} // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--list-microphones") return ListMicrophones();
  if (argc != 5) {
    std::cerr << "Usage: clipfarm-audio.exe <system-port|0> <microphone-port|0> <microphone-id|default> <gain>\n";
    return 1;
  }
  try {
    return Capture(std::stoi(argv[1]), std::stoi(argv[2]), argv[3], std::stof(argv[4]));
  } catch (...) {
    return 1;
  }
}
