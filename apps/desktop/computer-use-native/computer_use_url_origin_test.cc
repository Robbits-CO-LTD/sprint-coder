#include "computer_use_url_origin.h"
#include "computer_use_origin_classify_test.h"
#include "computer_use_effect_measurement.h"
#include <iostream>

using namespace sprint_coder::computer_use;

// Synthetic fixtures only. Failure output contains an ordinal and classification, never a URL.
int main() {
  if (!CheckOriginClassification()) return 10;
  struct Case {
    std::string_view input;
    std::string_view normalized;
    OriginState state = OriginState::kUnknown;
    bool dev_tools = false;
  };
  const Case cases[] = {
      {"HTTPS://Docs.Example:00443/a?q=test#part", "https://docs.example", OriginState::kOrdinary},
      {"http://docs.example:00080/", "http://docs.example", OriginState::kOrdinary},
      {"https://docs.example:08443/", "https://docs.example:8443", OriginState::kOrdinary},
      {"https://docs.example:65535/", "https://docs.example:65535", OriginState::kOrdinary},
      {"https://docs.example./", ""},
      {"http://localhost/", "http://localhost", OriginState::kOrdinary},
      {"https://bank.example/", "https://bank.example", OriginState::kOrdinary},
      {"https://docs.example/%E6%97%A5", "https://docs.example", OriginState::kOrdinary},
      {"file:///C:/synthetic/a.html", "", OriginState::kOrdinary},
      {"FILE://LOCALHOST/C:/synthetic/a.html", "", OriginState::kOrdinary},
      {"DEVTOOLS://DEVTOOLS/bundled/inspector.html", "devtools://devtools", OriginState::kOrdinary, true},
      {"chrome-devtools://devtools/", "chrome-devtools://devtools", OriginState::kOrdinary, true},
      {"", ""}, {"docs.example", ""}, {"https:///a", ""},
      {"https://bank.example.com@evil.test/", ""},
      {"https://user:pass@docs.example/", ""}, {"https://@docs.example/", ""},
      {"https://docs.example@bank.example@evil.test/", ""},
      {"https://bank.example%40evil.test/", ""},
      {"https://%64ocs.example/", ""}, {"https://docs%2eexample/", ""},
      {"http://127.0.0.1.nip.io/", ""}, {"http://127.0.0.1/", ""},
      {"http://127.1/", ""}, {"http://2130706433/", ""},
      {"http://0177.0.0.1/", ""}, {"http://0x7f000001/", ""},
      {"http://[::1]/", ""}, {"http://[::ffff:127.0.0.1]/", ""},
      {"https://xn--bcher-kva.example/", ""}, {"https://XN--BCHER-KVA.example/", ""},
      {"https://xn--invalid-/", ""},
      {"https://b\xc3\xbc" "cher.example/", ""},
      {"https://\xef\xbd\x82" "ank.example/", ""},
      {"https://b\xd0\xb0nk.example/", ""},
      {"https://docs\xe3\x80\x82" "example/", ""},
      {"https://docs.example../", ""}, {"https://a..example/", ""},
      {"https://-docs.example/", ""}, {"https://docs-.example/", ""},
      {"https://docs_example/", ""}, {"https://:443/", ""},
      {"https://docs.example:/", ""}, {"https://docs.example:0/", ""},
      {"https://docs.example:65536/", ""}, {"https://docs.example:443:80/", ""},
      {"https://docs.example:+443/", ""}, {"https://docs.example:abc/", ""},
      {" https://docs.example/", ""}, {"https://docs.example/ ", ""},
      {"https://docs.example\\@evil.test/", ""},
      {"https://docs.example/%0a", ""}, {"https://docs.example/%5c", ""},
      {"https://docs.example/%", ""}, {"https://docs.example/%zz", ""},
      {"file://remote.example/share/a", ""}, {"file:C:/synthetic/a", ""},
      {"file://localhost", ""}, {"file://localhost:80/a", ""},
      {"data:text/html,synthetic", ""}, {"javascript:void(0)", ""},
      {"blob:https://docs.example/synthetic", ""},
      {"filesystem:https://docs.example/temporary/a", ""},
      {"about:blank", ""}, {"about:srcdoc", ""},
      {"vscode-file://vscode-app/synthetic/a", ""}, {"app://synthetic/a", ""},
      {"chrome://settings/", ""}, {"edge://settings/", ""},
      {"ftp://docs.example/a", ""}, {"view-source:https://docs.example/", ""},
      {"devtools:", "", OriginState::kUnknown, true},
      {"devtools:///a", "", OriginState::kUnknown, true},
      {"DEVTOOLS://x.y:/", "", OriginState::kUnknown, true},
      {"devtools://devtools:9222/", "", OriginState::kUnknown, true},
      {"devtools://dev_tools/", "", OriginState::kUnknown, true},
      {"devtools://123/", "", OriginState::kUnknown, true},
      {"file:////server/share/a.html", ""},
      {"file://///server/share/a.html", ""},
      {"file://localhost//server/share/a", ""},
      {"file:////?/UNC/server/share/a", ""},
      {"file:///synthetic/a", ""}, {"file:///C:relative", ""},
      {"file:///C:", "", OriginState::kOrdinary},
      {"file:///z|/synthetic/a", "", OriginState::kOrdinary},
      {"https://127-0-0-1.nip.io/", ""},
      {"https://7f000001.nip.io/", ""},
      {"https://10-0-0-1.sslip.io/", ""},
      {"https://ABCDEF01.example/", ""},
      {"https://999-999-999-999.example/", ""},
      {"https://1-2-3.example/", "https://1-2-3.example", OriginState::kOrdinary},
      {"https://1234-2-3-4.example/", "https://1234-2-3-4.example", OriginState::kOrdinary},
  };
  std::size_t index = 0;
  for (const auto &entry : cases) {
    ++index;
    const auto result = NormalizeUrlOrigin(entry.input);
    if (result.normalized_origin != entry.normalized || result.state != entry.state ||
        result.dev_tools != entry.dev_tools) {
      std::cerr << "golden-classification FAIL " << index << '\n';
      return 1;
    }
    const auto page = ClassifyPageOrigin(entry.input);
    if (page.state == OriginState::kOrdinary ||
        NormalizeOrigin(entry.input) != page.normalized_origin) return 11;
    ShadowAxCapture capture;
    capture.web_area_url_read = true;
    capture.web_area_url = entry.input;
    EffectFacts binding_facts;
    binding_facts.origin = OriginState::kOrdinary;
    const auto binding = DeriveAuthorityBinding(capture, {}, {}, binding_facts, {});
    if (binding.complete != !page.normalized_origin.empty() ||
        binding.binding.origin.present != !page.normalized_origin.empty() ||
        binding.binding.origin.value != page.normalized_origin) return 12;
    EffectFacts facts;
    facts.metadata_complete = facts.chain_complete = facts.text_language_supported = true;
    facts.action = ActionKind::kScroll;
    facts.mode = SessionMode::kFullAccess;
    facts.surface = SurfaceKind::kOrdinary;
    facts.chain.push_back({"AXWebArea", "", ""});
    ApplyUrlOrigin(result, &facts);
    const auto expected = entry.dev_tools ? DecisionKind::kBlocked :
        entry.state == OriginState::kUnknown ? DecisionKind::kTakeover : DecisionKind::kOrdinary;
    if (ClassifyEffect(facts).kind != expected) {
      std::cerr << "classifier-handoff FAIL " << index << '\n';
      return 1;
    }
    facts.origin = OriginState::kUnknown;
    ApplyUrlOrigin(result, &facts);
    if (facts.origin != OriginState::kUnknown) return 8;
    facts.origin = OriginState::kSensitive;
    facts.surface = SurfaceKind::kOrdinary;
    ApplyUrlOrigin(result, &facts);
    if (facts.origin != OriginState::kSensitive ||
        (!entry.dev_tools && ClassifyEffect(facts).kind != DecisionKind::kTakeover)) return 2;
    facts.surface = SurfaceKind::kShellLike;
    ApplyUrlOrigin(result, &facts);
    if (facts.surface != SurfaceKind::kShellLike) return 3;
    if (NormalizeUrlOrigin(entry.input, false).state != OriginState::kUnknown) return 4;
    if (!result.normalized_origin.empty()) {
      const auto again = NormalizeUrlOrigin(result.normalized_origin);
      if (again.normalized_origin != result.normalized_origin || again.state != result.state ||
          again.dev_tools != result.dev_tools) return 5;
    }
  }
  const OriginState states[] = {OriginState::kNotApplicable, OriginState::kOrdinary,
                                OriginState::kUnknown, OriginState::kSensitive};
  for (std::size_t before = 0; before < 4; ++before) {
    for (std::size_t incoming = 0; incoming < 4; ++incoming) {
      EffectFacts facts;
      facts.origin = states[before];
      ApplyUrlOrigin({states[incoming], false, {}}, &facts);
      if (facts.origin != states[before > incoming ? before : incoming]) return 9;
    }
  }
  for (unsigned c = 0; c <= 255; ++c) {
    if (c > 32 && c < 127) continue;
    const std::string url = "https://docs.example/" + std::string(1, static_cast<char>(c));
    if (NormalizeUrlOrigin(url).state != OriginState::kUnknown) return 6;
  }
  for (const auto &url : {std::string(8193, 'a'),
                         "https://" + std::string(64, 'a') + ".example/"})
    if (NormalizeUrlOrigin(url).state != OriginState::kUnknown) return 7;
  std::cout << "URL origin golden + classifier handoff: PASS\n";
  return 0;
}
