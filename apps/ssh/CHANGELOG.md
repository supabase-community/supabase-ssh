# Changelog

## [0.1.2](https://github.com/supabase-community/supabase-ssh/compare/v0.1.1...v0.1.2) (2026-04-09)


### Features

* **ssh:** otel sampling ([b1ea798](https://github.com/supabase-community/supabase-ssh/commit/b1ea79801bafc810df18d73cf276283368d40e07))
* **ssh:** otel sampling ([2cdc391](https://github.com/supabase-community/supabase-ssh/commit/2cdc391939b9b8e976836f58bf46cfdf1eaeb5ad))


### Bug Fixes

* **ssh:** use max reducer on grafana overview stat panels ([7c7b266](https://github.com/supabase-community/supabase-ssh/commit/7c7b2663e807a6c932597c8e3861d1861d73f02b))
* **ssh:** use max reducer on grafana overview stat panels ([e13ff49](https://github.com/supabase-community/supabase-ssh/commit/e13ff49100c91880b72ca985282e6bc78da3a6a0))

## [0.1.1](https://github.com/supabase-community/supabase-ssh/compare/v0.1.0...v0.1.1) (2026-03-30)


### Features

* command cache ([9d92dc2](https://github.com/supabase-community/supabase-ssh/commit/9d92dc2781c6aa5eac2caae17c1d80cf9143dc29))
* dedicated workspace app for ssh ([62b49ea](https://github.com/supabase-community/supabase-ssh/commit/62b49ea77eaaa8d887b4b16cbcc32937c80eb31e))
* download docs from public archive ([0625fa6](https://github.com/supabase-community/supabase-ssh/commit/0625fa697452faccb8079ef7a7b31559058e7ee5))
* http exec endpoint ([a1c092d](https://github.com/supabase-community/supabase-ssh/commit/a1c092d961029677be832a7fe9d49bf2349c6bde))
* **ssh:** add createShellSession ([d899241](https://github.com/supabase-community/supabase-ssh/commit/d899241ae6b1ff96292862f50eb701dbb3523ed0))
* **ssh:** add gradual ramp scenario to load tests ([fa2d360](https://github.com/supabase-community/supabase-ssh/commit/fa2d3608c76da518f38533791bfef0167321cbe5))
* **ssh:** add metrics configuration to fly.toml ([55d7da1](https://github.com/supabase-community/supabase-ssh/commit/55d7da1bf0dc9445474d4c92cccb6e97424ccd37))
* **ssh:** add web static export to docker build ([9fee995](https://github.com/supabase-community/supabase-ssh/commit/9fee99529408536166f4102df6cb22e1d1fcff56))
* **ssh:** adjust fly settings based on load test results ([eb95801](https://github.com/supabase-community/supabase-ssh/commit/eb9580179ab0d610bf8eb677f0f9872ee4a5d112))
* **ssh:** calibrate limits from Fly load test results ([9d7e23d](https://github.com/supabase-community/supabase-ssh/commit/9d7e23d0230d592b0f2c134b959ce1bda466a81a))
* **ssh:** capture real agent sessions for load test profiles ([3fe1d37](https://github.com/supabase-community/supabase-ssh/commit/3fe1d37832a8cbb51b45021da2a1bd3bb415864a))
* **ssh:** completion engine ([b843b96](https://github.com/supabase-community/supabase-ssh/commit/b843b9696386b945b6f6f03ed984e4235482c808))
* **ssh:** connection limits and idle timeout ([c6cf575](https://github.com/supabase-community/supabase-ssh/commit/c6cf575d465f257056ad997599f4dff055fcd772))
* **ssh:** defense-in-depth, exec timeout, and tightened limits ([887ce3d](https://github.com/supabase-community/supabase-ssh/commit/887ce3debce9bbd41c10e8e4a15abbf0c4f44662))
* **ssh:** execution limit hardening / attack surface tests ([97b4291](https://github.com/supabase-community/supabase-ssh/commit/97b4291976aebd3721438cf2632ed84c1fa93c2c))
* **ssh:** explicit kex algorithm whitelist ([43967c8](https://github.com/supabase-community/supabase-ssh/commit/43967c8427fb2b802b88e0b7e8e180a701b3324e))
* **ssh:** expose version ([aec8f17](https://github.com/supabase-community/supabase-ssh/commit/aec8f17f5d6addf26912fc46171e115876b53de4))
* **ssh:** expose version ([b1fbfd0](https://github.com/supabase-community/supabase-ssh/commit/b1fbfd047657eec73c2aa57cdbf199c59a85e57a))
* **ssh:** feature flag exec api ([b01f3e5](https://github.com/supabase-community/supabase-ssh/commit/b01f3e5561b638990825db757404675ce62732a6))
* **ssh:** feature flag exec api ([584d17f](https://github.com/supabase-community/supabase-ssh/commit/584d17f304266981f29cd5bf7ec0ca0751c8a1f3))
* **ssh:** friendly message when rejecting connections at capacity ([24660c7](https://github.com/supabase-community/supabase-ssh/commit/24660c7d2d9bd00d56179d4cedfc39ce852d1f16))
* **ssh:** graceful rolling deploys with connection draining ([bfb2854](https://github.com/supabase-community/supabase-ssh/commit/bfb2854c60338cdc149f0e7908f8b36459879c80))
* **ssh:** grafana dashboards ([ee6ad1f](https://github.com/supabase-community/supabase-ssh/commit/ee6ad1febd95fbf4113318b14c5d46ec32dc4b1a))
* **ssh:** home dir with ~ completion ([f5fc2b6](https://github.com/supabase-community/supabase-ssh/commit/f5fc2b69595e5b7db410690b724700cd1e8cd306))
* **ssh:** increase idle timeout to 60 seconds ([d2fd813](https://github.com/supabase-community/supabase-ssh/commit/d2fd813f6a621537807eb2a98283d09ff2d75c7b))
* **ssh:** layer Fly proxy concurrency limits with app-level RED/hard cap ([0dabd51](https://github.com/supabase-community/supabase-ssh/commit/0dabd51be3d58a53714d17888b9cbee5aab7360e))
* **ssh:** load test tooling ([d92b3d8](https://github.com/supabase-community/supabase-ssh/commit/d92b3d80f01935331128e32d485fff62119eebf8))
* **ssh:** max session timeout ([98a4bf8](https://github.com/supabase-community/supabase-ssh/commit/98a4bf8e933ddd27e4af2dfbcfae4a20c4b3de71))
* **ssh:** metrics ([0cf9d1a](https://github.com/supabase-community/supabase-ssh/commit/0cf9d1a9fdfb28fdb6af3551db2499b38601c2de))
* **ssh:** mount AGENTS.md inside vfs ([1ed5889](https://github.com/supabase-community/supabase-ssh/commit/1ed5889b96747bfc2047492eaf302f5c73fd8e66))
* **ssh:** native bash aliases ([b0b9775](https://github.com/supabase-community/supabase-ssh/commit/b0b977578cee8163d428c062f0b1d4d1be69906a))
* **ssh:** notify active shells immediately on sigint ([bec8abe](https://github.com/supabase-community/supabase-ssh/commit/bec8abe96e30f3f257b4a7ca36fa0f0af623ccf4))
* **ssh:** otel for file and dir reads ([a2e8d0e](https://github.com/supabase-community/supabase-ssh/commit/a2e8d0e5c97e83aa1acba840e72e27dc194ece43))
* **ssh:** per-IP concurrent connection limit ([fdad4a4](https://github.com/supabase-community/supabase-ssh/commit/fdad4a44e48b1fa283c8ba01e293adcaa1977cc6))
* **ssh:** probabilistic connection drop with soft/hard limits ([62350a8](https://github.com/supabase-community/supabase-ssh/commit/62350a83367502a68f6a64a658d699334b9ee7ca))
* **ssh:** pty detection ([69c925a](https://github.com/supabase-community/supabase-ssh/commit/69c925a595f13aafa8768c37042193db24cc08c6))
* **ssh:** rate limits ([fdc64ce](https://github.com/supabase-community/supabase-ssh/commit/fdc64cea280c04452836e42e3b6c9e218da3bb84))
* **ssh:** reject connections at auth phase via auth banner ([d70b831](https://github.com/supabase-community/supabase-ssh/commit/d70b831fc6ceb08a249409459b3ab7c3cdfdcc22))
* **ssh:** remove subnet from otel ([270aa27](https://github.com/supabase-community/supabase-ssh/commit/270aa27c4074f34a0390a0d0b297605226a8a63c))
* **ssh:** serve static files from hono ([554e993](https://github.com/supabase-community/supabase-ssh/commit/554e993edc3d5043a7c47d74f55ed2eef73b7927))
* **ssh:** SETUP.md ([d6ab8d7](https://github.com/supabase-community/supabase-ssh/commit/d6ab8d7cb13092c5923514e728d29dc91b93d790))
* **ssh:** SKILL.md ([93ae7f4](https://github.com/supabase-community/supabase-ssh/commit/93ae7f48453958abaf1fa4a8a24c587de071f306))
* **ssh:** split server errors from command exit codes in load test runner ([cd16f3c](https://github.com/supabase-community/supabase-ssh/commit/cd16f3c84c1910f445da6d3f10584e0edd9d3e96))
* **ssh:** switch from tsx to pre-built ([4b5a9f4](https://github.com/supabase-community/supabase-ssh/commit/4b5a9f485533a0188d111ca9af0e890a8271e7cd))
* **ssh:** telemetry ([7430458](https://github.com/supabase-community/supabase-ssh/commit/7430458ebc9e2e48b3a6df3fcaefa39fd298587e))
* **ssh:** test coverage ([36c8891](https://github.com/supabase-community/supabase-ssh/commit/36c889136358006ad359bbb9c0dfb0937d5abb92))
* **ssh:** unified shutdown notifications for exec and shell channels ([64f3996](https://github.com/supabase-community/supabase-ssh/commit/64f3996616c1620e16a54aa77a13dee0f9fd49fd))
* **ssh:** update banner with setup instructions ([8b713dd](https://github.com/supabase-community/supabase-ssh/commit/8b713ddc6b3c1966419d6664fb698310d29e963f))
* **ssh:** use readline for ssh shell sessions ([df43d18](https://github.com/supabase-community/supabase-ssh/commit/df43d18a57786261e941eaa1ffac4fc7a21895a1))
* **ssh:** WEB_DIR env var ([4b2f055](https://github.com/supabase-community/supabase-ssh/commit/4b2f0556b41b832b7ee8264631e5edfe20f7ec6e))
* viral load test ([0199e5d](https://github.com/supabase-community/supabase-ssh/commit/0199e5daf5db129682256b2c6c7d3b1a1827591e))


### Bug Fixes

* docs tarball ([740fc96](https://github.com/supabase-community/supabase-ssh/commit/740fc96defa20e05212ed40ca6633f9117186063))
* http health check for api server ([94ae231](https://github.com/supabase-community/supabase-ssh/commit/94ae2318fe7fee7a06d4a700885797c4e7a8496e))
* node types during build ([d08ce73](https://github.com/supabase-community/supabase-ssh/commit/d08ce7359b6030716b4fe1ceaee4ab36dbd24904))
* remove npx from e2e tests ([8b5e436](https://github.com/supabase-community/supabase-ssh/commit/8b5e4362d9f5f647378720325ad571541a1b6b83))
* **ssh:** add port 80 redirect and cert setup docs ([6fdd7d7](https://github.com/supabase-community/supabase-ssh/commit/6fdd7d73e3c323e625ca9aec0e1199558785c878))
* **ssh:** add port 80 redirect and cert setup docs ([13fc5c5](https://github.com/supabase-community/supabase-ssh/commit/13fc5c577ea65b8a86702c55c95ba2e0cea0c3cf))
* **ssh:** await stderr flush before tearing down connections ([5fedd47](https://github.com/supabase-community/supabase-ssh/commit/5fedd47c362f91147633502866ff7b6a0242f70b))
* **ssh:** delay transport teardown for message delivery ([b450729](https://github.com/supabase-community/supabase-ssh/commit/b450729f0fac5ad80745b521a874c72b455e2db3))
* **ssh:** docker web builds ([0367373](https://github.com/supabase-community/supabase-ssh/commit/03673735f8e7933152d315c380106062707685df))
* **ssh:** drop duplicate memory gauges ([0666056](https://github.com/supabase-community/supabase-ssh/commit/0666056425a03b96e91755ae1daaec62de6e2798))
* **ssh:** ipv6 allocation docs ([bf9d817](https://github.com/supabase-community/supabase-ssh/commit/bf9d817da6a332dfbfcac6d54f0cb5cd5bae2f7e))
* **ssh:** update message handling to use stdout instead of stderr ([db2d6f2](https://github.com/supabase-community/supabase-ssh/commit/db2d6f2b05ac1f2be39f2f18c6bf088585e5f994))
