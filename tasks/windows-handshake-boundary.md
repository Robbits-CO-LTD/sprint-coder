# Windows V1 handshake and connection barrier

This connected slice addresses #500's unsupported-mode fail-closed boundary and #703's independently reproduced parallel-call race. It depends on PR699 (213224b41f88e03e7b103c8f1a4ea83aa40a527f).

The existing strict V1 handshake schema is moved into a pure module and shared by signed-addon exposure and every Windows named-pipe connection. Existing valid optional ProbeJson metadata remains supported; unknown mode/ruleset/classifier/lexicon claims fail closed. Source binding remains mandatory. Calls await an in-flight connection before trusting a non-null socket, so operations cannot precede handshake validation.

Regression evidence: removing only the promise-first barrier makes the real transport fixture serve list_windows while handshake is held (expected no operations). The corrected desktop workspace suites pass 132 tests: native98, host17, transport13, module graph4. Transport fixtures mock spawn, named pipe and attestation; they are not an actual signed Windows native acceptance run. First connection and reconnect are checked for both held-valid handshake and unsupported claims with parallel callers.

No native source, input authority, feature activation, ticket or classifier is added. Native-owned ticket mint/retain/consume and coordinated V2 mode/classifier/ruleset remain source/artifact-validation dependencies; they are not completed by this boundary. Signing, package build, workflow dispatch, paid APIs and #694 probes were not performed. Existing V1/OFF policy and approved limitations remain intact.
