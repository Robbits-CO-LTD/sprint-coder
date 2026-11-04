#pragma once
#include <windows.h>
#include <iostream>
#include <mutex>
#include <string>

// JSONL contains only synthetic fixture state and OS metadata, never window text.
inline std::mutex evidence_mutex;
inline void Evidence(const char* kind, const std::string& fields = "") {
  std::lock_guard<std::mutex> lock(evidence_mutex);
  std::cout << "{\"kind\":\"" << kind << "\",\"tickMs\":" << GetTickCount64()
            << ",\"pid\":" << GetCurrentProcessId() << fields << "}" << std::endl;
}
inline std::string Number(const char* key, unsigned long long value) {
  return ",\"" + std::string(key) + "\":" + std::to_string(value);
}
inline unsigned long long WindowId(HWND hwnd) {
  return reinterpret_cast<ULONG_PTR>(hwnd);
}
