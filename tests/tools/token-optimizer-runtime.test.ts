import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  buildTokenOptimizerReportInvocation,
  createDefaultTokenOptimizerDeps,
  reconcileTokenOptimizer,
  TOKEN_OPTIMIZER_PIN,
  TOKEN_OPTIMIZER_SOURCE_DIGEST,
  type TokenOptimizerConfigureResult,
  type TokenOptimizerOwnedPath,
  type TokenOptimizerProject,
  type TokenOptimizerReceipt,
  tokenOptimizerManagedBlockSha256,
  tokenOptimizerReceiptPath,
} from "../../src/tools/token-optimizer-runtime.js";

const roots: string[] = [];
const PINNED_RELEASE_MANIFEST =
  "90f7ebcd5d67059a2002028c5bb0c311e32f81dfa6b509fc6df5297a5a20f900  .claude-plugin/marketplace.json\n374f28a03e88364095bebcb20732c83892c616d5e7609be570770ee9b47c596d  .claude-plugin/plugin.json\n857b5b6c0cae88d9fbb0d4ecb94bdad65bbf5a05c19e75f89972161cb2162b23  .codex-plugin/plugin.json\n8ffd584493c1cc77d756027d1b68861282fdf9b87305aace31922e7c9f048cf1  hooks/codex-hooks.json\n4bf49a3e5ee1e27435d7973d1d6e53df541dc0ca1ac1ca8521cabb4cbc1926cf  hooks/hooks.json\ndd8df583078060b62a9a06b04b53dbfbbbf89d410e90ec044dac38aa9d42172b  hooks/module_runner.py\n78bc226f5671a60f62d4f1253a8445e9403234209254b4ab907bfd1e6be8082c  hooks/posttooluse_runner.py\n0e4ed1bca220dd7aadc90bef7e1c0be96668595d9eb4a1410a5de9c7e5d29f1d  hooks/python-launcher.sh\n400442750c056e5822c27b5e03ca2ce549843b1f029736f8ed185aebede656c4  hooks/run.py\n6ad25938134b053d70c90c247a85d0a4e5e05172269896a7903e1542288aafb4  hooks/sessionstart_runner.py\n5862482801579a970b379519cd5d58eb7cfab691fd26c79800608227d336ba6f  hooks/stop_runner.py\nd4990741d213105a3455237806d30279df9ac562580c92bdb512902cfad4cc36  hooks/userpromptsubmit_runner.py\ndbdc027072c97ba02a4e5fc7a3b6b589b6f01c0e6e05d091a5e9ed2ad026dc53  install.sh\n01701c0c9a80b074d0589a2f0d299efaa18c828fb8f7f853fffc7d0f9129eab7  skills/fleet-auditor/SKILL.md\n078dbfe73bd3b86b03b65655c61a2d8bf84d95df9861c454ea753aba416e4fdb  skills/fleet-auditor/references/fleet-systems.md\n3e5203b719acb1d4fed1a6d742c3bcae08f4f64f2210cd566f2e95bec5c34249  skills/fleet-auditor/references/waste-patterns.md\n2cf3ebc61df3c32f8d8cda9f422e0f6f526b159ffc2a3a03b5c5b5577e104c3d  skills/fleet-auditor/scripts/fleet.py\n8ea774d6adcbfcfc770c13252c16f71595d284a5389b81b6867ae0a5c3bd2503  skills/fleet-auditor/scripts/shared.py\nec8c4faa651f3fa70ad19aa24f93449f0e2d9cff547a486313f736a22283f819  skills/resume-checkpoint/SKILL.md\ndeb694350e05fcf23eeba5a02f72d9daaa688fab0ba29e19e76917dbba685b04  skills/resume-checkpoint/scripts/pull_checkpoint.py\nd8de713c8e9809916e41da24a2518958e760bb9c451cd92d424ba0b089c0f6e3  skills/token-coach/SKILL.md\n9410dcc6339c19217e3e1fed67b258f035203638ff943fd9b58f83af897246cc  skills/token-coach/assets/coach-dashboard-tab.html\n71b5491602344cb2474c922e7b03eaa3a95d6c9c9748ccc5e6c3ace6f7be6ec1  skills/token-coach/examples/coaching-session-agentic.md\n63791e259203d592dd2c99050a5fde26b1b15e9455687bd2fd1b1d3f480f595d  skills/token-coach/examples/coaching-session-heavy-setup.md\n404498e61a70ca4398d8c149f7b2a979f4b80477ae4c57d023b2ae232b346c29  skills/token-coach/examples/coaching-session-new-project.md\ncf1ec48194ba18346f726957067205227c3e0f9b8094b8ebdbbfe941e4a7432c  skills/token-coach/references/agentic-systems.md\neccabc8bba20cd28c5debe51ba2ca76bef6beeef15674903cf88c0433cea6f2e  skills/token-coach/references/coach-patterns.md\n3053fe9a319d274e299c0bee179261efd66df5d82c516ed71d61db09578211ed  skills/token-coach/references/coaching-scripts.md\ne4329fdcacbfeee2e90fe37f0ae01fed8ea6b66a6d36a0a5397fe51bcb68e58c  skills/token-coach/references/quick-reference.md\n469b4ac26d5c1f0d04bd3ec6ce51a701179fbfb9054f73b69a34b6632741ce3e  skills/token-dashboard/SKILL.md\n0d42f4ea127069f1ed2839241ce169a5019d81c8331aec83452c61b3196501e6  skills/token-optimizer/SKILL.md\n0eb5fddc16bd9913e525defa9d53397d0f9521198ffa05faded2156405aea182  skills/token-optimizer/assets/active-compression-hero.svg\n2c2bd2a6282fac11c5559c5ab6f9785de0ca6dddb6e30a3baa32214c7cec2595  skills/token-optimizer/assets/automated-flow.svg\na70264fe1939d3d278aa4770db5fc497288adac57dc9b60f3b3a00deedffb079  skills/token-optimizer/assets/bash-compression.svg\n6221e23e643ca00eb6da56fee7c9d57811e5b728c93f3ad3b2118d68b2b4ab7b  skills/token-optimizer/assets/before-after.svg\nd58cd90f6503a92816417e158edd632253b2470ae72dba497d0d5cedd551a298  skills/token-optimizer/assets/dashboard-demo.gif\n56f9b41cc979dc9f96fbc28ffabbe47e9e6bd48e74ae16905e52fddbbcd8d840  skills/token-optimizer/assets/dashboard-demo.mp4\n02c4f7c70a14a4a23a1f629a18906ca70e011e3cbe993219d5eceb2b468c5943  skills/token-optimizer/assets/dashboard-overview.png\n277523a16c21a5af1d303d0020ebc2f5bf6a0557e8ef4f51dc65c6af83dd19be  skills/token-optimizer/assets/dashboard.html\n98fb7e1f60abb982a620a0e6a981ee30c77136cb4bb58927266aa158e6ecd2b1  skills/token-optimizer/assets/delta-mode.svg\n306a88ea301858b5e92625256dc4828a81ed213140c4715714ce7ec26498f4e0  skills/token-optimizer/assets/fleet-demo.html\nd0f05944252fc00f15d4b1abc8ba4507741b3f0e5ad822ea5e8f886964cf4509  skills/token-optimizer/assets/hero-terminal.svg\n4d95f14459b765e550e3a54756fe71c0ae8df8c5815590f862e477b0ee04e102  skills/token-optimizer/assets/how-it-works.svg\n4d185b01bbf7ebf2bed1992d94d0c793a2173c7e7bd499a115b17c29aa7ab8fe  skills/token-optimizer/assets/logo.svg\nd69d215a2fb3880bef5a1c6575b24740c9b85ace4deb63669e1ca96b4232e723  skills/token-optimizer/assets/logo.txt\n7821f986184e9725833a19867b1a221299aac15f8f0df6caf24e1d35e6c80447  skills/token-optimizer/assets/quality-example.svg\nd5c014a223609c6fe76ae02c39d91462ce6a461b930d96d899129bd223d70e14  skills/token-optimizer/assets/quality-nudges-loops.svg\n91abcacc40107f348c7c488b375694eaf867baee7848391ab93a096561ec0a01  skills/token-optimizer/assets/real-savings.svg\n3abe4c1a6a7aaf4f71dabe63cda9a6a48d714dea6333acfc1efd963eb7eddd14  skills/token-optimizer/assets/session-database-flow.svg\n4802987c471bad975b0be57b21e3d2a99ac3e8a65f48408fba0be8f038acadb6  skills/token-optimizer/assets/status-bar.svg\n50b2d3469f996a75c40f1e6685c3e28b8e5cdf02fda041a8373d4fb959da17d5  skills/token-optimizer/assets/user-profiles.svg\nf22252b76f9f798c3c764c91ba081a8b8c4a0d2f3bd06436c5ddf75b5496dc5d  skills/token-optimizer/examples/claude-md-optimized.md\nb7dd90a17e1016c9b7cb5f905c5203500b7087e6fdee31f727b90c22e196db5f  skills/token-optimizer/examples/hooks-starter.json\nee2be403e15f3affd6951d10f9018f4e2283441a7dac21e191b3c054989bdc8c  skills/token-optimizer/examples/permissions-deny-template.json\n0a4adb8851b2b71f72edf46dfb2efac28809743f87631c9c088e8248db30a67c  skills/token-optimizer/references/agent-prompts.md\n9a3f0146726ec1cabe767843fc2e9171d497a8aaac9de852bd203c5454a558a0  skills/token-optimizer/references/cli-reference.md\nbe2a92d8ee30c98c8a7051989099edde18a2dcdf26e1131e0bcd906817afd7f0  skills/token-optimizer/references/codex-workflow.md\n2473e04cae5712af02d645613fb06a9d29c44b7d50b8395292d7e89782879a75  skills/token-optimizer/references/cursor-workflow.md\n30dde7f9c7af43e66e109c32c6dd6624d5136bfae7b4852b29ab2a2ce3bb001a  skills/token-optimizer/references/error-recovery.md\n6542aaaa88f7027afb355ad3d0c1814194d261319afcfbbe2c5c9f6a9fabc245  skills/token-optimizer/references/implementation-playbook.md\n4d50ccc927e46a6e8d2e1b0038fd0a5d7a7dfe6b6cf1313a7c25d77f8cf22099  skills/token-optimizer/references/opencode-workflow.md\n29436aad71b223be70d607f86ca80dbf1506cbcf15c28e172d3f564199f42f06  skills/token-optimizer/references/optimization-checklist.md\n4bd1590fb8741ec937d7c4313238983edd5cbe477d478c80ed29fa58dace569f  skills/token-optimizer/references/phase0-setup.md\n45fba0389eb950c47ee6dd4a87632c625ffdaf865ff2c43cc93f7997e64e9c63  skills/token-optimizer/references/presentation-workflow.md\nd51a8fbb84be48d09db883703d402f9b0619f8bf88eb7142e233218cd25d5004  skills/token-optimizer/references/token-flow-architecture.md\nb1ccc6e69e2632966bc474db62027579966bba36e9fd33aed75233b71c921bcf  skills/token-optimizer/scripts/activity_tracker.py\ncc59768feaf7b883cef597ad519fbd61b25654dc30f1f0cc4467c8a4646c7fa6  skills/token-optimizer/scripts/antigravity_doctor.py\n71fa704332b704164ce78bbcbd6735db972221bcbe82bbfa38888fa9c88b953b  skills/token-optimizer/scripts/antigravity_hook_bridge.py\n30c68a2773718fd280600b5eed170356015762b96559255977bd158c30067ba9  skills/token-optimizer/scripts/antigravity_install.py\n144dec5879d912a08769da62b23194c228d51065fdf626bd5acc5e7b585c04d9  skills/token-optimizer/scripts/antigravity_proto.py\nede7082b24e046b2d289bc66ba03389b8a5bd6f878259b20a3eafa29bf6f9edd  skills/token-optimizer/scripts/antigravity_session.py\n60052e41f2c776745a89dfd26fc09f77fad6996c38f5ed43b14c63ebdef6d4be  skills/token-optimizer/scripts/antigravity_state.py\na41cde8b9267618ecaf0ccaef10d6e1a732549d300ac1cabe8ceb3fe654f5763  skills/token-optimizer/scripts/archive_result.py\n541d80525539585be41cdd2267d486b40a3e2a91c255b415aa9944681e4a30c9  skills/token-optimizer/scripts/bash_compress.py\nd9537dfb881f1b4512846474c9edc2aa85c711c04a66778ccd107d9b0c1e4bd4  skills/token-optimizer/scripts/bash_compress_hook.py\n80459ff70b07beb55745ecd355406176a811623d37149dcf5ad61fdb7c1378ff  skills/token-optimizer/scripts/bash_hook.py\n575999417ebb78c5b8ef2971290cc9c5a4900d07027b4cd57d60ee1fb9074bc2  skills/token-optimizer/scripts/bash_whitelist.py\n72914be6f04f89516d8ae2ec0e0c92b50373314a7a502ae63bc8579204818505  skills/token-optimizer/scripts/benchmark.py\nf6a2bafd11aec3559ac1791bfc0a4b1665788491452c5243b7fbfa3961470254  skills/token-optimizer/scripts/build_output_compress.py\n2929d1838762dc28d67f9d73c76279bc9399ce1c46b7cbe93c263da4cf274d6d  skills/token-optimizer/scripts/codex_command_compress.py\n5145f92c58a04a70d54aeda1932ff5ad3b7d2f684dc0e71e9781f4da005d5c93  skills/token-optimizer/scripts/codex_compact_prompt.py\n7872e56dd26e19a2b925f31c6291aac00a3857fdc3ded2b9c44f42522e928101  skills/token-optimizer/scripts/codex_doctor.py\n0a9115da55f27f6110efea994261d308e6a8cd770d12fbe93212891636b622f8  skills/token-optimizer/scripts/codex_hook_bridge.py\ne2086721cc853591816a85e11a09fea3d0d9cc0a1fb30ad51364a21dcb705c0c  skills/token-optimizer/scripts/codex_install.py\n39c2d05a032487efdf5b8523799de21375cb7a70de4637d4d931d47fbbe85afd  skills/token-optimizer/scripts/codex_io.py\n267150b7b278178158439f65938e1ad15b86b234823cf820e16369061ae552f6  skills/token-optimizer/scripts/codex_log_index.py\n251a4e359454641cd8c74445d769d00f3dc4a85d0098616473d204809bda7f4c  skills/token-optimizer/scripts/codex_models.py\nece6f5f034474c0d27eb1611cb933c29c1ab1bc6a1f00603bf5a8e3031103f1e  skills/token-optimizer/scripts/codex_session.py\ndcc2ebe434d19fbad2229450066c3fc3a060ce646a63a110bb362ec349b2bd2d  skills/token-optimizer/scripts/codex_state.py\ne23f6588109fcf67569c237b0aabba0eb2debf0179b22abfa9588e5177f11c4b  skills/token-optimizer/scripts/codex_statusline.py\nbbb2e5845933d4e4f166e1a551b743a56db61e49d0b0cf715f8a1ca239cae5a9  skills/token-optimizer/scripts/command_filters.py\n7a6700c6a4d8b8ddc845cf99204c5e12307617af47acc2674399a6455b717907  skills/token-optimizer/scripts/compression_backfill.py\n347df1e311d1fdd993661b909406921a8dc3c36a8bdc47e2a56972aa794a5aad  skills/token-optimizer/scripts/compression_log.py\nec76ead70f24db78d3c5df70c908affd740cf9b92909ce3a181f453bc5345c1c  skills/token-optimizer/scripts/context_intel.py\ndbd7e280acfbe4b0842839d221748b6ba1122fb6828bd822a4e36d61c4e7d2be  skills/token-optimizer/scripts/context_pressure.py\n52f14b6a55a2273af90d89ea24d6a1eec18dae580f701afa515a8968a39a29d7  skills/token-optimizer/scripts/copilot_doctor.py\n0622aee5afa7ccda19ba99ef06e4362e5711f00338f721e16294835e818b6a3f  skills/token-optimizer/scripts/copilot_hook_bridge.py\n7a841e4a7ef4716bd2ab8841c5a945101e518c92a9d6bbc6fe8b1084a6a1d0b7  skills/token-optimizer/scripts/copilot_install.py\nb3eae57156d76a39b20eb8f3f5c9272aa64023d5d37f223a90c8a8453728b32e  skills/token-optimizer/scripts/copilot_session.py\n8c034fc52778e8194d54c12b1cecccde56d1ccbaaf5119914634331929cd927e  skills/token-optimizer/scripts/copilot_state.py\n0870dac309e6904621968b2efee829763510b8736f3bdea2b004cadf03cf7d52  skills/token-optimizer/scripts/copilot_vscode.py\nfa4ac79ecb32f17df14649dde03391b1f6cf540672b6be3899da4df71fae930e  skills/token-optimizer/scripts/cowork_doctor.py\na0ea11012e46e305949a219c52f5a1af5c263cd15d5ff71c3125ce73770223ff  skills/token-optimizer/scripts/cowork_install.py\n7c3ffcbdbab51cab0cc594e642dc95550d5dc7b8c24b062b971cf8993afe8549  skills/token-optimizer/scripts/credential_patterns.py\n24fcb1021c48d4bdbd498207331fb6b71257dc4fab2578776d0d14a03e5c5aa1  skills/token-optimizer/scripts/cursor_doctor.py\n9db31f14ff27afc1f65840ddb1045d956639db300547c837540737d862c34de3  skills/token-optimizer/scripts/cursor_hook_bridge.py\nb614616163cdf982f3a56ec05f9e124509fadba8cae34fe6455af16db01a36c3  skills/token-optimizer/scripts/cursor_install.py\nd79e23538591018c7b0fe659974fdd8862a39a5e5fc00e906a315f9fe41ef160  skills/token-optimizer/scripts/cursor_session.py\n093216550b4a1928d696ea753a03b1312e5de76e2f84d1a270d5eafa190ab1d5  skills/token-optimizer/scripts/cursor_state.py\nde506f1aea65d21570b6cd8d47ba12feed7d5dca51e0a8fcbeaad63c32465cf1  skills/token-optimizer/scripts/delta_diff.py\na010b8469a17165848e4a0777af59350c308dd4139721271894f3df2063a75d0  skills/token-optimizer/scripts/detectors/__init__.py\ncf4e8751d33ae096ffee05171fb739d0f167d253ab1dcaa544e755f03e25da7f  skills/token-optimizer/scripts/detectors/bad_decomposition.py\n49f2f1a253e9d390d0301ec3306573c8c208455a7b40ccd8df57139b228a4dbb  skills/token-optimizer/scripts/detectors/cache_instability.py\nbda6d69a36ff7a0fcff1e4a55372c37035e172ed03d89a911fbfc83a6e0800ba  skills/token-optimizer/scripts/detectors/looping.py\ne843d6e486cf429a4d54808cff1542744f5a564087cfc4c9265d03ee37908ce3  skills/token-optimizer/scripts/detectors/output_waste.py\n0ef74987eef51826d57735193f5c0a491c7041065cd26964e317718b920a5894  skills/token-optimizer/scripts/detectors/overpowered.py\nf72ea1bfed510c1e2711c314a9e0d6d81ba82c185b6a3655d6772af124e8c243  skills/token-optimizer/scripts/detectors/pdf_ingestion.py\n81a93d3c01a7fe80b16fcff7151680243b40ced6671903fe843a3aa0069470b8  skills/token-optimizer/scripts/detectors/registry.py\naf5a096114dbf90c1ace395b751e7178baaf000e82b90e71c4fcfb3e6fdd51e1  skills/token-optimizer/scripts/detectors/respond_to_bash.py\nee5b0e91cce18a825a401f7fe6b85911be15e259db3f2f4afc0b326b19128385  skills/token-optimizer/scripts/detectors/retry_churn.py\n833496b308cd3034ac1fd9401c1b824c3c64cd02f89abac02d6f4cd97e9ea16f  skills/token-optimizer/scripts/detectors/tool_cascade.py\nb8345d767a48f40d275480973681baf56dc76329d8f3eaa6260966d6d6b787cd  skills/token-optimizer/scripts/detectors/wasteful_thinking.py\n19bd7d9fcb292e21377e8f21a0c401019e90e6e925cf8f0ed1087c196c1b8c55  skills/token-optimizer/scripts/detectors/weak_model.py\nfef4a2385caf3c9495987007d16edf73a022cddbd0aecf2293025e3d9599996d  skills/token-optimizer/scripts/detectors/websearch_routing.py\n7c7443075daafd297218cc4e30178e43d4f5ed1319c9bf9d252412b3e586bc8b  skills/token-optimizer/scripts/grok_doctor.py\nb4c28ae5e1c89de069d149fe549955b5e4e1704d2e38edabc3f71517d4cca087  skills/token-optimizer/scripts/grok_hook_bridge.py\n20b97dd589644692fdc0d8d7c3bb99dcc3bd96b26bf5bf3e73d6ac2817a0d742  skills/token-optimizer/scripts/grok_install.py\n6792c75ebcbc1066b61275d0ef5278a9af7a4cb776eff2e3add1b40704402f44  skills/token-optimizer/scripts/grok_session.py\nbb3d3a4289216607a95695b1f9f30acbab04d2a4b305c95b9f3d6541a2180e59  skills/token-optimizer/scripts/grok_state.py\na98e37ce9f7d7b8cc12eb8e38a5c2b94e660b2404bf5100793ccba686b5e7510  skills/token-optimizer/scripts/hermes_doctor.py\n4b4faeea428535fa2b5f9e7994e287ab043fef82a3fa2bad0208691679498431  skills/token-optimizer/scripts/hermes_hook_bridge.py\nf64b5c2fa2a3415fdf0b9097f8274a74eb943aabd8861040bc915eedb2baca78  skills/token-optimizer/scripts/hermes_install.py\na62fde80c927ae187efe3915e24c9bceff13d3749d0a1eb7c1ab46a87188ceee  skills/token-optimizer/scripts/hermes_session.py\n74ca40b79fa3811382b29e34094dbfdfb568af2969fc7a34382c4e47fd386b52  skills/token-optimizer/scripts/hermes_state.py\nc68d12578671bcbe8273ded991858e17ecd97ea6c087dc306b95e410cba42de9  skills/token-optimizer/scripts/hook_io.py\n270dfa3ced4819591876d21ce3df747e3867b5ea62b9ec04e28a807c265d39f6  skills/token-optimizer/scripts/hook_runtime.py\nf647eabc7067499b74f72c4ba5c55738fdc18c6539a7a5b99c65d03126016d8d  skills/token-optimizer/scripts/injection.py\n8504876437930537702f954c3339e3c84fa9099bf4ad8dfa53dce2299caa9dd1  skills/token-optimizer/scripts/install_reconcile.py\ncad09bac209cc4360fd05d4a4e5182b333e9be4ade2671ee726a392984aa3314  skills/token-optimizer/scripts/measure.py\nbd27835f85c5fd45c9cf67cb8b969038489249c56182ec2638a4f1223799b98f  skills/token-optimizer/scripts/outline.py\n4e103d92829aa5fa851be923ad87aa1b548b17638ce3b090c66fa558f0279f17  skills/token-optimizer/scripts/pipeline_analyzer.py\n94e4c12851d746ba4caba68ccb04793eafd24b88a32189a86d515d21fca05540  skills/token-optimizer/scripts/plugin_env.py\nc1e9af1560aa99cfb48f205076fb3c30b7b48e7a9ec0cd36155778b711e71fb8  skills/token-optimizer/scripts/py_trust.py\n03f6dce67e36484baa8d85d2ba3cda8198f9c9c82b560cf98d646718385131d8  skills/token-optimizer/scripts/quality_cache_gate.py\naab6d7ae2dcf9ec591a4b19f32a3001b546429794e95bf682a52670d95d771b5  skills/token-optimizer/scripts/read_cache.py\n722499df4363f1bbb4259a8d33fad47c571c83e0304483781d79003d9ee7a910  skills/token-optimizer/scripts/refetch_fingerprint.py\nc768a1cb5cdaa2bce6d765f8fc328891213f528aa876d66eb479768d3a348f42  skills/token-optimizer/scripts/refetch_guard.py\nf098ece01bc8acf55493ee1f2f482af8fb16f4a9c6a4664784074fd73f41e866  skills/token-optimizer/scripts/routing_advisor.py\ne2605f386ebf88fbbdba87d56395debb12710a2baabcc9094a4e2a31df5debc5  skills/token-optimizer/scripts/runtime_env.py\n47c3eb92ad33dadaa29437a91e82fb7500429f1c5e75b6ee07cc7272337f6f52  skills/token-optimizer/scripts/session_store.py\nedcad0d766033f18b0decdc7a85365322037d2423ffb02fa13bd1bf89ac9ddbd  skills/token-optimizer/scripts/spawn_utils.py\n9f6cee162c701470bb6dd12472dcbc5b53c01d45e4057b0c047fb24cb1edb6bb  skills/token-optimizer/scripts/statusline.js\ne43ca6e2bf0955bd88f1dcf1103bf8ca747f388a8947570591e31fec11009e38  skills/token-optimizer/scripts/structure_map.py\n4fe0f40dc7e482bc21ff3091d1761a70af454b0d1dd6bcb985457f72315a5481  skills/token-optimizer/scripts/structure_map_ts.py\n2d6e2ae6e0c571a5178515403ca0a58c3368526e3c65926301b6278f09f4edd9  skills/token-optimizer/scripts/structure_replay.py\ncd338022b5477e291438ba59601aea0f8171cc699e521f41f7bead8ec2fe22c2  skills/token-optimizer/scripts/thrash_guard.py\n9bc912e9896e16c921c907d6fdf2e558413846c7f20a43eaa153a87c30a4d5e5  skills/token-optimizer/scripts/token_estimate.py\n012434c528a9b440f1fce2786ba702c2b03c2a4af9c7e5392589b74d7b812a06  skills/token-optimizer/scripts/utf8_io.py\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  project: TokenOptimizerProject;
  installRoot: string;
  checkoutRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "aih-token-optimizer-test-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const installRoot = join(root, "runtimes");
  const checkoutRoot = join(installRoot, "token-optimizer", "v5.13.14");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  const scriptRoot = join(checkoutRoot, "skills", "token-optimizer", "scripts");
  mkdirSync(scriptRoot, { recursive: true });
  writeFileSync(join(scriptRoot, "measure.py"), "print('synthetic report')\n", "utf8");
  mkdirSync(join(checkoutRoot, "hooks"), { recursive: true });
  writeFileSync(join(checkoutRoot, "hooks", "run.py"), "# synthetic hook runner\n", "utf8");
  const launcher = join(checkoutRoot, "hooks", "python-launcher.sh");
  writeFileSync(launcher, "#!/usr/bin/env bash\n", "utf8");
  if (process.platform !== "win32") chmodSync(launcher, 0o755);
  return {
    root,
    project: { canonicalRoot: projectRoot, stateRoot },
    installRoot,
    checkoutRoot,
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hooksPath(project: TokenOptimizerProject): string {
  return join(project.canonicalRoot, ".codex", "hooks.json");
}

function integrationPath(project: TokenOptimizerProject): string {
  return join(project.stateRoot, "token-optimizer", "integration.json");
}

type ManagedHookEvent =
  | "Stop"
  | "SessionStart"
  | "UserPromptSubmit"
  | "SubagentStart"
  | "SubagentStop";

const POSIX_HOOK_PREFIX =
  'for b in bash /bin/bash /usr/bin/bash /usr/local/bin/bash /opt/homebrew/bin/bash; do command -v "$b" >/dev/null 2>&1 && ';

function posixQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function windowsQuote(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function managedHookCommand(
  event: ManagedHookEvent,
  checkoutRoot: string,
  pythonExecutable: string,
): string {
  const runPy = join(checkoutRoot, "hooks", "run.py");
  const launcher = join(checkoutRoot, "hooks", "python-launcher.sh");
  const invocations: Record<
    ManagedHookEvent,
    { script: string; args: string[]; redirectQuiet: boolean }
  > = {
    Stop: { script: "hooks/stop_runner.py", args: [], redirectQuiet: true },
    SessionStart: {
      script: "hooks/sessionstart_runner.py",
      args: [],
      redirectQuiet: false,
    },
    UserPromptSubmit: {
      script: "hooks/userpromptsubmit_runner.py",
      args: [],
      redirectQuiet: false,
    },
    SubagentStart: {
      script: "skills/token-optimizer/scripts/codex_hook_bridge.py",
      args: ["subagent-start"],
      redirectQuiet: false,
    },
    SubagentStop: {
      script: "skills/token-optimizer/scripts/codex_hook_bridge.py",
      args: ["subagent-stop"],
      redirectQuiet: true,
    },
  };
  const invocation = invocations[event];
  const argv = [invocation.script, ...invocation.args];
  if (process.platform === "win32") {
    const command = [pythonExecutable, runPy, ...argv].map(windowsQuote).join(" ");
    return `set "TOKEN_OPTIMIZER_RUNTIME=codex" && ${command}${
      invocation.redirectQuiet ? " >NUL 2>&1" : ""
    }`;
  }
  const command = [launcher, runPy, ...argv].map(posixQuote).join(" ");
  return `${POSIX_HOOK_PREFIX}TOKEN_OPTIMIZER_RUNTIME=codex exec "$b" ${command}${
    invocation.redirectQuiet ? " >/dev/null 2>&1" : ""
  }; done; exit 0`;
}

function managedHook(
  checkoutRoot = "C:/synthetic-token-optimizer",
  pythonExecutable = join(checkoutRoot, "python.exe"),
): Record<string, unknown> {
  return {
    hooks: [
      {
        type: "command",
        command: managedHookCommand("Stop", checkoutRoot, pythonExecutable),
        timeout: 15,
      },
    ],
  };
}

function managedHookForEvent(
  event: ManagedHookEvent,
  checkoutRoot: string,
  pythonExecutable: string,
): Record<string, unknown> {
  const timeout =
    event === "Stop" ? 15 : event === "SessionStart" || event === "UserPromptSubmit" ? 20 : 6;
  return {
    hooks: [
      {
        type: "command",
        command: managedHookCommand(event, checkoutRoot, pythonExecutable),
        timeout,
      },
    ],
  };
}

function managedHooks(
  profile: "quiet" | "balanced",
  checkoutRoot: string,
  pythonExecutable: string,
): Record<string, unknown> {
  const events: ManagedHookEvent[] =
    profile === "balanced"
      ? ["Stop", "SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop"]
      : ["Stop"];
  return {
    hooks: Object.fromEntries(
      events.map((event) => [event, [managedHookForEvent(event, checkoutRoot, pythonExecutable)]]),
    ),
  };
}

function writeExecutable(path: string, contents = "synthetic executable\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

function externalBin(root: string, name: string): string {
  const executable = join(root, process.platform === "win32" ? `${name}.exe` : name);
  writeExecutable(executable);
  return executable;
}

async function withPath<T>(pathValue: string, action: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  const originalPathAlias = process.env.Path;
  try {
    process.env.PATH = pathValue;
    process.env.Path = pathValue;
    return await action();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathAlias === undefined) delete process.env.Path;
    else process.env.Path = originalPathAlias;
  }
}

function customHook(): Record<string, unknown> {
  return {
    hooks: [{ type: "command", command: "custom-tool --preserve" }],
  };
}

function managedOwnedPaths(
  project: TokenOptimizerProject,
  checkoutRoot?: string,
  pythonExecutable?: string,
): TokenOptimizerOwnedPath[] {
  const managed = managedHook(checkoutRoot, pythonExecutable);
  const integration = integrationPath(project);
  const bytes = Buffer.from('{"profile":"quiet"}\n', "utf8");
  mkdirSync(dirname(integration), { recursive: true });
  writeFileSync(integration, bytes);
  mkdirSync(dirname(hooksPath(project)), { recursive: true });
  writeFileSync(hooksPath(project), `${JSON.stringify({ hooks: { Stop: [managed] } }, null, 2)}\n`);
  return [
    { path: integration, sha256: sha256(bytes), ownership: "file" },
    {
      path: hooksPath(project),
      sha256: tokenOptimizerManagedBlockSha256(managed),
      ownership: "managed-block",
    },
  ];
}

function configuredResult(
  project: TokenOptimizerProject,
  checkoutRoot: string,
  changed: boolean,
): TokenOptimizerConfigureResult {
  const ownedPaths = managedOwnedPaths(project, checkoutRoot);
  return { ownedPaths, detail: "project-scoped Token Optimizer hooks configured", changed };
}

function baseReceipt(
  project: TokenOptimizerProject,
  ownedPaths: readonly TokenOptimizerOwnedPath[],
): TokenOptimizerReceipt {
  return {
    version: "developer-tool-receipt/v1",
    toolId: "token-optimizer",
    sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
    canonicalRoot: project.canonicalRoot,
    profile: "quiet",
    ownedPaths,
  };
}

describe("Token Optimizer ordinary adopter runtime", () => {
  it("reports policy exclusion without acquiring or mutating an empty selection", async () => {
    const { project, installRoot } = fixture();
    let acquired = 0;
    let configured = 0;
    let verified = 0;
    const result = await reconcileTokenOptimizer(
      { project, installRoot, selected: false, acceptLicense: false, profile: "quiet" },
      {
        acquire: async () => {
          acquired += 1;
          throw new Error("must not acquire");
        },
        configure: async () => {
          configured += 1;
          throw new Error("must not configure");
        },
        verifyRuntime: async () => {
          verified += 1;
          throw new Error("must not verify");
        },
        readReceipt: async () => undefined,
      },
    );

    expect(result).toMatchObject({ state: "policy-excluded", changed: false });
    expect(acquired).toBe(0);
    expect(configured).toBe(0);
    expect(verified).toBe(0);
  });

  it("blocks before acquisition when the PolyForm license is not accepted", async () => {
    const { project, installRoot } = fixture();
    let acquired = 0;
    const result = await reconcileTokenOptimizer(
      { project, installRoot, selected: true, acceptLicense: false, profile: "balanced" },
      {
        acquire: async () => {
          acquired += 1;
          throw new Error("must not acquire");
        },
        readReceipt: async () => undefined,
      },
    );

    expect(result.state).toBe("blocked");
    expect(result.detail.toLowerCase()).toContain("license");
    expect(result.changed).toBe(false);
    expect(acquired).toBe(0);
  });

  it("writes a digest-bound receipt and reconciles repeated setup idempotently", async () => {
    const { project, installRoot, checkoutRoot } = fixture();
    let receipt: unknown;
    let acquireCalls = 0;
    let configureCalls = 0;
    let receiptWrites = 0;
    const deps = {
      acquire: async (request: {
        installRoot: string;
        source: typeof import("../../src/tools/token-optimizer-runtime.js").TOKEN_OPTIMIZER_PIN;
      }) => {
        acquireCalls += 1;
        expect(request.installRoot).toBe(installRoot);
        expect(request.source.commit).toBe("37a9546b9fecba2c4e9a02ef4e90855d449bf08f");
        return {
          checkoutRoot,
          sourceDigest: baseReceipt(project, []).sourceDigest,
          reused: acquireCalls > 1,
        };
      },
      configure: async () => {
        configureCalls += 1;
        return configuredResult(project, checkoutRoot, configureCalls === 1);
      },
      verifyRuntime: async () => ({ ok: true, detail: "synthetic offline report succeeded" }),
      readReceipt: async () => receipt,
      writeReceipt: async (_path: string, value: TokenOptimizerReceipt) => {
        receiptWrites += 1;
        receipt = value;
      },
    };

    const first = await reconcileTokenOptimizer(
      { project, installRoot, selected: true, acceptLicense: true, profile: "quiet" },
      deps,
    );
    const second = await reconcileTokenOptimizer(
      { project, installRoot, selected: true, acceptLicense: true, profile: "quiet" },
      deps,
    );

    expect(first.state).toBe("verified");
    expect(first.changed).toBe(true);
    expect(first.receipt?.ownedPaths).toHaveLength(2);
    expect(first.receipt?.ownedPaths.every((item) => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(
      true,
    );
    expect(second.state).toBe("verified");
    expect(second.changed).toBe(false);
    expect(acquireCalls).toBe(2);
    expect(configureCalls).toBe(2);
    expect(receiptWrites).toBe(1);
  });

  it("removes unchanged owned integration while preserving a custom hook", async () => {
    const { project, installRoot, checkoutRoot } = fixture();
    let receipt: unknown;
    const setupDeps = {
      acquire: async () => ({
        checkoutRoot,
        sourceDigest: baseReceipt(project, []).sourceDigest,
        reused: false,
      }),
      configure: async () => configuredResult(project, checkoutRoot, true),
      verifyRuntime: async () => ({ ok: true, detail: "synthetic offline report succeeded" }),
      readReceipt: async () => receipt,
      writeReceipt: async (_path: string, value: TokenOptimizerReceipt) => {
        receipt = value;
      },
    };
    const setup = await reconcileTokenOptimizer(
      { project, installRoot, selected: true, acceptLicense: true, profile: "quiet" },
      setupDeps,
    );
    receipt = setup.receipt;
    const hooks = JSON.parse(readFileSync(hooksPath(project), "utf8")) as {
      hooks: { Stop: unknown[] };
    };
    hooks.hooks.Stop.push(customHook());
    writeFileSync(hooksPath(project), `${JSON.stringify(hooks, null, 2)}\n`);

    const excluded = await reconcileTokenOptimizer(
      { project, installRoot, selected: false, acceptLicense: true, profile: "quiet" },
      {
        readReceipt: async () => receipt,
        deleteReceipt: async () => {
          receipt = undefined;
        },
      },
    );

    expect(excluded.state).toBe("policy-excluded");
    expect(excluded.changed).toBe(true);
    expect(existsSync(integrationPath(project))).toBe(false);
    const remaining = JSON.parse(readFileSync(hooksPath(project), "utf8")) as {
      hooks: { Stop: unknown[] };
    };
    expect(remaining.hooks.Stop).toEqual([customHook()]);
    expect(receipt).toBeUndefined();
  });

  it("keeps the receipt and reports blocked when the synthetic report fails", async () => {
    const { project, installRoot, checkoutRoot } = fixture();
    let receipt: unknown;
    const result = await reconcileTokenOptimizer(
      { project, installRoot, selected: true, acceptLicense: true, profile: "quiet" },
      {
        acquire: async () => ({
          checkoutRoot,
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
          reused: false,
        }),
        configure: async () => configuredResult(project, checkoutRoot, true),
        verifyRuntime: async () => ({ ok: false, detail: "synthetic report returned no data" }),
        readReceipt: async () => receipt,
        writeReceipt: async (_path: string, value: TokenOptimizerReceipt) => {
          receipt = value;
        },
      },
    );

    expect(result.state).toBe("blocked");
    expect(result.detail).toContain("no data");
    expect(result.receipt?.ownedPaths).toHaveLength(2);
    expect(receipt).toEqual(result.receipt);
  });

  it("blocks and preserves a receipt-owned file changed by the user", async () => {
    const { project, installRoot, checkoutRoot } = fixture();
    const ownedPaths = managedOwnedPaths(project);
    const receipt = baseReceipt(project, ownedPaths);
    writeFileSync(integrationPath(project), '{"profile":"custom"}\n', "utf8");
    const result = await reconcileTokenOptimizer(
      { project, installRoot, selected: false, acceptLicense: true, profile: "quiet" },
      { readReceipt: async () => receipt },
    );

    expect(result.state).toBe("blocked");
    expect(result.changed).toBe(false);
    expect(readFileSync(integrationPath(project), "utf8")).toBe('{"profile":"custom"}\n');
    expect(existsSync(hooksPath(project))).toBe(true);
    expect(checkoutRoot).toBeTruthy();
  });

  it("rejects an ambiguous receipt before invoking any dependency", async () => {
    const { project, installRoot } = fixture();
    const outside = join(project.stateRoot, "outside.txt");
    let acquired = 0;
    const receipt = baseReceipt(project, [
      { path: outside, sha256: "not-a-digest", ownership: "file" },
    ]);

    await expect(
      reconcileTokenOptimizer(
        { project, installRoot, selected: true, acceptLicense: true, profile: "quiet" },
        {
          acquire: async () => {
            acquired += 1;
            throw new Error("must not acquire");
          },
          readReceipt: async () => receipt,
        },
      ),
    ).rejects.toThrow(/receipt/i);
    expect(acquired).toBe(0);
  });

  it("rejects a schema-valid receipt that claims an arbitrary project file", async () => {
    const { project, installRoot } = fixture();
    const victim = join(project.canonicalRoot, "README.md");
    const victimBytes = Buffer.from("user-owned project material\n", "utf8");
    writeFileSync(victim, victimBytes);
    const receipt = baseReceipt(project, [
      { path: victim, sha256: sha256(victimBytes), ownership: "file" },
    ]);
    let acquired = 0;

    await expect(
      reconcileTokenOptimizer(
        { project, installRoot, selected: false, acceptLicense: true, profile: "quiet" },
        {
          acquire: async () => {
            acquired += 1;
            throw new Error("must not acquire");
          },
          readReceipt: async () => receipt,
        },
      ),
    ).rejects.toThrow(/allowlist/i);
    expect(acquired).toBe(0);
    expect(readFileSync(victim)).toEqual(victimBytes);
  });

  it("restores custom hooks if the upstream installer clobbers them", async () => {
    const { project, checkoutRoot } = fixture();
    const pythonExecutable = join(project.stateRoot, "external-python.exe");
    mkdirSync(dirname(pythonExecutable), { recursive: true });
    writeFileSync(pythonExecutable, "synthetic python\n", "utf8");
    if (process.platform !== "win32") chmodSync(pythonExecutable, 0o755);
    const before = {
      hooks: {
        Stop: [customHook()],
        SessionStart: [{ hooks: [{ type: "command", command: "user-start --preserve" }] }],
      },
      userSetting: "preserve",
    };
    mkdirSync(dirname(hooksPath(project)), { recursive: true });
    const beforeBytes = Buffer.from(`${JSON.stringify(before, null, 2)}\n`, "utf8");
    writeFileSync(hooksPath(project), beforeBytes);
    const runner = fakeRunner(() => {
      writeFileSync(
        hooksPath(project),
        `${JSON.stringify({ hooks: { Stop: [managedHook(checkoutRoot, pythonExecutable)] } }, null, 2)}\n`,
        "utf8",
      );
      return { stdout: "{}" };
    });
    const deps = createDefaultTokenOptimizerDeps({ runner, pythonExecutable });

    await expect(
      deps.configure({
        checkoutRoot,
        project,
        profile: "quiet",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      }),
    ).rejects.toThrow(/custom|existing setting/i);
    expect(readFileSync(hooksPath(project))).toEqual(beforeBytes);
    expect(existsSync(integrationPath(project))).toBe(false);
  });

  it("blocks verification when an installed hook command is malformed", async () => {
    const { project, installRoot, checkoutRoot } = fixture();
    let receipt: unknown;
    const result = await reconcileTokenOptimizer(
      { project, installRoot, selected: true, acceptLicense: true, profile: "quiet" },
      {
        acquire: async () => ({
          checkoutRoot,
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
          reused: false,
        }),
        configure: async () => {
          const ownedPaths = managedOwnedPaths(project, checkoutRoot);
          const parsed = JSON.parse(readFileSync(hooksPath(project), "utf8")) as {
            hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
          };
          const stopGroup = parsed.hooks.Stop[0];
          const stopHook = stopGroup?.hooks[0];
          if (stopGroup === undefined || stopHook === undefined) {
            throw new Error("synthetic hook fixture is incomplete");
          }
          stopHook.command =
            "definitely-not-an-executable skills/token-optimizer/scripts/measure.py --broken";
          writeFileSync(hooksPath(project), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
          const integrationClaim = ownedPaths[0];
          const hooksClaim = ownedPaths[1];
          if (integrationClaim === undefined || hooksClaim === undefined) {
            throw new Error("synthetic ownership fixture is incomplete");
          }
          return {
            ownedPaths: [
              integrationClaim,
              {
                ...hooksClaim,
                sha256: tokenOptimizerManagedBlockSha256(stopGroup),
              },
            ],
            detail: "configured",
            changed: true,
          };
        },
        verifyRuntime: async () => ({ ok: true, detail: "direct report passed" }),
        readReceipt: async () => receipt,
        writeReceipt: async (_path: string, value: TokenOptimizerReceipt) => {
          receipt = value;
        },
      },
    );

    expect(result.state).toBe("blocked");
    expect(result.detail).toMatch(/hook command|configuration/i);
    expect(receipt).toBeUndefined();
  });

  it("runs the supported offline report command through the default verifier", async () => {
    const { project, checkoutRoot, root } = fixture();
    const seen: string[][] = [];
    const pythonExecutable = join(root, "external-python.exe");
    writeFileSync(pythonExecutable, "synthetic python\n", "utf8");
    if (process.platform !== "win32") chmodSync(pythonExecutable, 0o755);
    mkdirSync(dirname(hooksPath(project)), { recursive: true });
    writeFileSync(
      hooksPath(project),
      `${JSON.stringify({ hooks: { Stop: [managedHook(checkoutRoot, pythonExecutable)] } }, null, 2)}\n`,
      "utf8",
    );
    const runner = fakeRunner((argv, options) => {
      seen.push([...argv]);
      expect(options?.env?.TOKEN_OPTIMIZER_RUNTIME).toBe("codex");
      expect(options?.env?.TOKEN_OPTIMIZER_SNAPSHOT_DIR).toContain(project.stateRoot);
      return { stdout: "TOKEN OVERHEAD REPORT\n" };
    });
    const deps = createDefaultTokenOptimizerDeps({ runner, pythonExecutable });
    const result = await deps.verifyRuntime({ checkoutRoot, project, profile: "quiet" });
    const invocation = buildTokenOptimizerReportInvocation(checkoutRoot, project, "python3");

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toBe(
      process.platform === "win32"
        ? pythonExecutable
        : join(checkoutRoot, "hooks", "python-launcher.sh"),
    );
    expect(seen[0]?.[1]).toBe(join(checkoutRoot, "hooks", "run.py"));
    expect(seen[0]).toEqual([
      process.platform === "win32"
        ? pythonExecutable
        : join(checkoutRoot, "hooks", "python-launcher.sh"),
      join(checkoutRoot, "hooks", "run.py"),
      "hooks/stop_runner.py",
    ]);
    expect(seen[1]?.at(-1)).toBe("report");
    expect(invocation.argv.at(-1)).toBe("report");
  });

  it("fails verification when the executable hook launcher cannot run", async () => {
    const { project, checkoutRoot, root } = fixture();
    const pythonExecutable = join(root, "external-python.exe");
    writeFileSync(pythonExecutable, "synthetic python\n", "utf8");
    if (process.platform !== "win32") chmodSync(pythonExecutable, 0o755);
    const launcher = join(checkoutRoot, "hooks", "python-launcher.sh");
    const hookRunner = join(checkoutRoot, "hooks", "run.py");
    if (process.platform === "win32") {
      writeFileSync(hookRunner, "# synthetically broken hook runner\n", "utf8");
    } else {
      writeFileSync(launcher, "#!/definitely-missing-python\n", "utf8");
      chmodSync(launcher, 0o755);
    }
    mkdirSync(dirname(hooksPath(project)), { recursive: true });
    writeFileSync(
      hooksPath(project),
      `${JSON.stringify({ hooks: { Stop: [managedHook(checkoutRoot, pythonExecutable)] } }, null, 2)}\n`,
      "utf8",
    );
    const runner = fakeRunner((argv) => {
      if (
        (process.platform !== "win32" && argv[0] === launcher) ||
        (process.platform === "win32" && argv[1] === hookRunner)
      ) {
        return { code: 127, spawnError: true };
      }
      return { stdout: "TOKEN OVERHEAD REPORT\n" };
    });
    const deps = createDefaultTokenOptimizerDeps({ runner, pythonExecutable });

    const result = await deps.verifyRuntime({ checkoutRoot, project, profile: "quiet" });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/hook invocation failed/i);
  });

  it("selects an absolute Python executable outside the consumer project", () => {
    const { project, checkoutRoot, root } = fixture();
    const shadowBin = join(project.canonicalRoot, "bin");
    const externalBin = join(root, "external-bin");
    mkdirSync(shadowBin, { recursive: true });
    mkdirSync(externalBin, { recursive: true });
    const executableName = process.platform === "win32" ? "python.exe" : "python3";
    const shadowExecutable = join(shadowBin, executableName);
    const externalExecutable = join(externalBin, executableName);
    writeFileSync(shadowExecutable, "shadow");
    writeFileSync(externalExecutable, "external");
    if (process.platform !== "win32") {
      chmodSync(shadowExecutable, 0o755);
      chmodSync(externalExecutable, 0o755);
    }
    const originalPath = process.env.PATH;
    const originalPathAlias = process.env.Path;
    try {
      process.env.PATH = [shadowBin, externalBin].join(process.platform === "win32" ? ";" : ":");
      const invocation = buildTokenOptimizerReportInvocation(checkoutRoot, project);
      expect(invocation.argv[0]).toBe(realpathSync.native(externalExecutable));
      expect(invocation.argv[0]).not.toBe(realpathSync.native(shadowExecutable));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathAlias === undefined) delete process.env.Path;
      else process.env.Path = originalPathAlias;
    }
  });

  it("fails closed when no absolute external Python executable is available", () => {
    const { project, checkoutRoot, root } = fixture();
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const originalPath = process.env.PATH;
    const originalPathAlias = process.env.Path;
    try {
      process.env.PATH = emptyBin;
      const error = (() => {
        try {
          buildTokenOptimizerReportInvocation(checkoutRoot, project);
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Python executable is unavailable/i);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathAlias === undefined) delete process.env.Path;
      else process.env.Path = originalPathAlias;
    }
  });

  it("excludes a Python executable planted in the shared runtime cache", () => {
    const { project, installRoot, checkoutRoot, root } = fixture();
    const shadowBin = join(installRoot, "shadow-bin");
    const externalBin = join(root, "external-cache-test-bin");
    mkdirSync(shadowBin, { recursive: true });
    mkdirSync(externalBin, { recursive: true });
    const executableName = process.platform === "win32" ? "python.exe" : "python3";
    const shadowExecutable = join(shadowBin, executableName);
    const externalExecutable = join(externalBin, executableName);
    writeFileSync(shadowExecutable, "cache shadow");
    writeFileSync(externalExecutable, "external");
    if (process.platform !== "win32") {
      chmodSync(shadowExecutable, 0o755);
      chmodSync(externalExecutable, 0o755);
    }
    const originalPath = process.env.PATH;
    const originalPathAlias = process.env.Path;
    try {
      process.env.PATH = [shadowBin, externalBin].join(process.platform === "win32" ? ";" : ":");
      const invocation = buildTokenOptimizerReportInvocation(checkoutRoot, project);
      expect(invocation.argv[0]).toBe(realpathSync.native(externalExecutable));
      expect(invocation.argv[0]).not.toBe(realpathSync.native(shadowExecutable));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathAlias === undefined) delete process.env.Path;
      else process.env.Path = originalPathAlias;
    }
  });

  it("generates a project-scoped quiet hook install with the supported runtime", async () => {
    const { project, checkoutRoot } = fixture();
    const seen: { argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
    const pythonExecutable = join(project.stateRoot, "external", "python.exe");
    mkdirSync(dirname(pythonExecutable), { recursive: true });
    writeFileSync(pythonExecutable, "synthetic python\n", "utf8");
    if (process.platform !== "win32") chmodSync(pythonExecutable, 0o755);
    const runner = fakeRunner((argv, options) => {
      seen.push({ argv: [...argv], cwd: options?.cwd, env: options?.env });
      expect(argv).toContain("codex-install");
      mkdirSync(dirname(hooksPath(project)), { recursive: true });
      writeFileSync(
        hooksPath(project),
        `${JSON.stringify({ hooks: { Stop: [managedHook(checkoutRoot, pythonExecutable)] } }, null, 2)}\n`,
        "utf8",
      );
      return { stdout: JSON.stringify({ profile: "quiet" }) };
    });
    const deps = createDefaultTokenOptimizerDeps({ runner, pythonExecutable });
    const configured = await deps.configure({
      checkoutRoot,
      project,
      profile: "quiet",
      sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv[0]).toBe(pythonExecutable);
    expect(seen[0]?.argv).toContain("--project");
    expect(seen[0]?.argv).toContain(project.canonicalRoot);
    expect(seen[0]?.argv).toContain("--profile");
    expect(seen[0]?.argv).toContain("quiet");
    expect(seen[0]?.argv).toContain("--skip-compact-prompt");
    expect(seen[0]?.argv).not.toContain("--global");
    expect(seen[0]?.argv).not.toContain("--enable-status-line");
    expect(seen[0]?.cwd).toBe(project.canonicalRoot);
    expect(seen[0]?.env?.TOKEN_OPTIMIZER_RUNTIME).toBe("codex");
    expect(seen[0]?.env?.CODEX_HOME).toContain(join(project.stateRoot, "token-optimizer"));
    expect(seen[0]?.env?.HOME).toContain(join(project.stateRoot, "token-optimizer"));
    expect(configured.ownedPaths.some((owned) => owned.ownership === "managed-block")).toBe(true);
  });

  it("rejects malformed reconcile inputs before reading or mutating project state", async () => {
    const cases: Array<{
      name: string;
      make: (fixtureValue: ReturnType<typeof fixture>) => unknown;
      message: RegExp;
    }> = [
      { name: "null input", make: () => null, message: /invalid Token Optimizer input/i },
      {
        name: "missing selection",
        make: ({ project, installRoot }) => ({ project, installRoot }),
        message: /selection or license/i,
      },
      {
        name: "non-boolean selection",
        make: ({ project, installRoot }) => ({
          project,
          installRoot,
          selected: "yes",
          acceptLicense: true,
          profile: "quiet",
        }),
        message: /selection or license/i,
      },
      {
        name: "non-boolean license",
        make: ({ project, installRoot }) => ({
          project,
          installRoot,
          selected: true,
          acceptLicense: "yes",
          profile: "quiet",
        }),
        message: /selection or license/i,
      },
      {
        name: "unknown profile",
        make: ({ project, installRoot }) => ({
          project,
          installRoot,
          selected: true,
          acceptLicense: true,
          profile: "verbose",
        }),
        message: /invalid Token Optimizer profile/i,
      },
      {
        name: "missing project",
        make: ({ installRoot }) => ({
          project: null,
          installRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        }),
        message: /invalid Token Optimizer project/i,
      },
      {
        name: "relative canonical root",
        make: ({ project, installRoot }) => ({
          project: { ...project, canonicalRoot: "relative/project" },
          installRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        }),
        message: /canonicalRoot must be absolute/i,
      },
      {
        name: "missing canonical root",
        make: ({ project, installRoot, root }) => ({
          project: { ...project, canonicalRoot: join(root, "does-not-exist") },
          installRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        }),
        message: /canonicalRoot does not exist/i,
      },
      {
        name: "state root file",
        make: ({ project, installRoot, root }) => {
          const stateFile = join(root, "state-file");
          writeFileSync(stateFile, "not a directory\n", "utf8");
          return {
            project: { ...project, stateRoot: stateFile },
            installRoot,
            selected: true,
            acceptLicense: true,
            profile: "quiet",
          };
        },
        message: /stateRoot must be a regular directory/i,
      },
      {
        name: "install root file",
        make: ({ project, root }) => {
          const installFile = join(root, "install-file");
          writeFileSync(installFile, "not a directory\n", "utf8");
          return {
            project,
            installRoot: installFile,
            selected: true,
            acceptLicense: true,
            profile: "quiet",
          };
        },
        message: /installRoot must be a regular directory/i,
      },
      {
        name: "shared install root equals project",
        make: ({ project }) => ({
          project,
          installRoot: project.canonicalRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        }),
        message: /installRoot must be distinct/i,
      },
    ];

    for (const testCase of cases) {
      const values = fixture();
      let readCount = 0;
      await expect(
        reconcileTokenOptimizer(testCase.make(values) as never, {
          readReceipt: async () => {
            readCount += 1;
            return undefined;
          },
        }),
      ).rejects.toThrow(testCase.message);
      expect(readCount, testCase.name).toBe(0);
    }
  });

  it("rejects malformed ownership receipts before exclusion cleanup", async () => {
    const cases: Array<{
      name: string;
      mutate: (receipt: Record<string, unknown>, values: ReturnType<typeof fixture>) => unknown;
      message: RegExp;
    }> = [
      {
        name: "null receipt",
        mutate: () => null,
        message: /invalid Token Optimizer receipt$/i,
      },
      {
        name: "receipt array",
        mutate: () => [],
        message: /invalid Token Optimizer receipt$/i,
      },
      {
        name: "extra receipt field",
        mutate: (receipt) => ({ ...receipt, extra: true }),
        message: /receipt fields/i,
      },
      {
        name: "wrong receipt identity",
        mutate: (receipt) => ({ ...receipt, toolId: "other-tool" }),
        message: /receipt identity/i,
      },
      {
        name: "unsafe source digest",
        mutate: (receipt) => ({ ...receipt, sourceDigest: "bad\u0001digest" }),
        message: /source identity/i,
      },
      {
        name: "unknown receipt profile",
        mutate: (receipt) => ({ ...receipt, profile: "verbose" }),
        message: /receipt profile/i,
      },
      {
        name: "relative receipt root",
        mutate: (receipt) => ({ ...receipt, canonicalRoot: "project" }),
        message: /canonical root/i,
      },
      {
        name: "receipt root mismatch",
        mutate: (receipt, values) => ({
          ...receipt,
          canonicalRoot: values.project.stateRoot,
        }),
        message: /does not match the project/i,
      },
      {
        name: "non-array ownership list",
        mutate: (receipt) => ({ ...receipt, ownedPaths: {} }),
        message: /owned paths/i,
      },
      {
        name: "ownership list over bound",
        mutate: (receipt) => ({
          ...receipt,
          ownedPaths: Array.from({ length: 257 }, () => ({
            path: "C:/synthetic/integration.json",
            sha256: "a".repeat(64),
            ownership: "file",
          })),
        }),
        message: /owned paths/i,
      },
      {
        name: "null ownership claim",
        mutate: (receipt) => ({ ...receipt, ownedPaths: [null] }),
        message: /owned path$/i,
      },
      {
        name: "extra ownership field",
        mutate: (receipt, values) => ({
          ...receipt,
          ownedPaths: [
            {
              path: integrationPath(values.project),
              sha256: "a".repeat(64),
              ownership: "file",
              extra: true,
            },
          ],
        }),
        message: /owned path fields/i,
      },
      {
        name: "unsafe owned path text",
        mutate: (receipt, values) => ({
          ...receipt,
          ownedPaths: [
            {
              path: `${integrationPath(values.project)}#unsafe`,
              sha256: "a".repeat(64),
              ownership: "file",
            },
          ],
        }),
        message: /owned path identity/i,
      },
      {
        name: "bad owned digest",
        mutate: (receipt, values) => ({
          ...receipt,
          ownedPaths: [
            { path: integrationPath(values.project), sha256: "not-a-digest", ownership: "file" },
          ],
        }),
        message: /owned path identity/i,
      },
      {
        name: "unsupported ownership class",
        mutate: (receipt, values) => ({
          ...receipt,
          ownedPaths: [
            {
              path: integrationPath(values.project),
              sha256: "a".repeat(64),
              ownership: "directory",
            },
          ],
        }),
        message: /owned path identity/i,
      },
      {
        name: "duplicate ownership claim",
        mutate: (receipt, values) => ({
          ...receipt,
          ownedPaths: [
            { path: integrationPath(values.project), sha256: "a".repeat(64), ownership: "file" },
            { path: integrationPath(values.project), sha256: "a".repeat(64), ownership: "file" },
          ],
        }),
        message: /ambiguous Token Optimizer receipt owned path$/i,
      },
      {
        name: "file claim outside integration allowlist",
        mutate: (receipt, values) => ({
          ...receipt,
          ownedPaths: [
            {
              path: join(values.project.stateRoot, "other.json"),
              sha256: "a".repeat(64),
              ownership: "file",
            },
          ],
        }),
        message: /outside the integration allowlist/i,
      },
    ];

    for (const testCase of cases) {
      const values = fixture();
      const valid = baseReceipt(values.project, []);
      await expect(
        reconcileTokenOptimizer(
          {
            project: values.project,
            installRoot: values.installRoot,
            selected: false,
            acceptLicense: true,
            profile: "quiet",
          },
          {
            readReceipt: async () =>
              testCase.mutate(valid as unknown as Record<string, unknown>, values),
          },
        ),
      ).rejects.toThrow(testCase.message);
      expect(existsSync(integrationPath(values.project)), testCase.name).toBe(false);
    }
  });

  it("handles empty and missing receipt-owned paths without touching unrelated project files", async () => {
    const values = fixture();
    const unrelated = join(values.project.canonicalRoot, "README.md");
    writeFileSync(unrelated, "user material\n", "utf8");
    let deleted = 0;
    const empty = await reconcileTokenOptimizer(
      {
        project: values.project,
        installRoot: values.installRoot,
        selected: false,
        acceptLicense: true,
        profile: "quiet",
      },
      {
        readReceipt: async () => baseReceipt(values.project, []),
        deleteReceipt: async () => {
          deleted += 1;
        },
      },
    );
    expect(empty).toMatchObject({ state: "policy-excluded", changed: false });
    expect(deleted).toBe(1);

    const missingClaim: TokenOptimizerOwnedPath = {
      path: integrationPath(values.project),
      sha256: "a".repeat(64),
      ownership: "file",
    };
    const missing = await reconcileTokenOptimizer(
      {
        project: values.project,
        installRoot: values.installRoot,
        selected: false,
        acceptLicense: true,
        profile: "quiet",
      },
      {
        readReceipt: async () => baseReceipt(values.project, [missingClaim]),
        deleteReceipt: async () => {
          deleted += 1;
        },
      },
    );
    expect(missing).toMatchObject({ state: "policy-excluded", changed: true });
    expect(readFileSync(unrelated, "utf8")).toBe("user material\n");
    expect(deleted).toBe(2);
  });

  it("preserves malformed or unreceipted managed hooks during exclusion", async () => {
    const values = fixture();
    const owned = managedOwnedPaths(values.project, values.checkoutRoot);
    const receipt = baseReceipt(values.project, owned);
    writeFileSync(hooksPath(values.project), "{not-json\n", "utf8");
    const malformed = await reconcileTokenOptimizer(
      {
        project: values.project,
        installRoot: values.installRoot,
        selected: false,
        acceptLicense: true,
        profile: "quiet",
      },
      { readReceipt: async () => receipt, deleteReceipt: async () => undefined },
    );
    expect(malformed.state).toBe("blocked");
    expect(existsSync(integrationPath(values.project))).toBe(true);

    const changed = managedHook(values.checkoutRoot);
    const changedHook = (changed.hooks as Array<Record<string, unknown>>)[0];
    const changedGroup = {
      ...changed,
      hooks: [
        {
          ...changedHook,
          command: `${String(changedHook?.command ?? "")} --changed`,
        },
      ],
    };
    writeFileSync(
      hooksPath(values.project),
      `${JSON.stringify({ hooks: { Stop: [changedGroup] } }, null, 2)}\n`,
      "utf8",
    );
    const unreceipted = await reconcileTokenOptimizer(
      {
        project: values.project,
        installRoot: values.installRoot,
        selected: false,
        acceptLicense: true,
        profile: "quiet",
      },
      { readReceipt: async () => receipt, deleteReceipt: async () => undefined },
    );
    expect(unreceipted.state).toBe("blocked");
    expect(unreceipted.detail).toMatch(/managed hook changed|unreceipted/i);
  });

  it("reports a blocked exclusion when receipt deletion fails after safe cleanup", async () => {
    const values = fixture();
    const owned = managedOwnedPaths(values.project, values.checkoutRoot);
    const receipt = baseReceipt(values.project, owned);
    const result = await reconcileTokenOptimizer(
      {
        project: values.project,
        installRoot: values.installRoot,
        selected: false,
        acceptLicense: true,
        profile: "quiet",
      },
      {
        readReceipt: async () => receipt,
        deleteReceipt: async () => {
          throw new Error("receipt store unavailable");
        },
      },
    );
    expect(result.state).toBe("blocked");
    expect(result.changed).toBe(true);
    expect(result.detail).toContain("receipt store unavailable");
    expect(existsSync(integrationPath(values.project))).toBe(false);
  });

  it("persists, reads, replaces, and deletes a receipt through the concrete file dependencies", async () => {
    const values = fixture();
    const deps = createDefaultTokenOptimizerDeps({ runner: fakeRunner(() => undefined) });
    const path = tokenOptimizerReceiptPath(values.project);
    const quiet = baseReceipt(values.project, []);
    expect(await deps.readReceipt(path)).toBeUndefined();

    await deps.writeReceipt(path, quiet);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(quiet);
    expect(await deps.readReceipt(path)).toEqual(quiet);

    const balanced = { ...quiet, profile: "balanced" as const };
    await deps.writeReceipt(path, balanced);
    expect(await deps.readReceipt(path)).toEqual(balanced);

    await deps.deleteReceipt(path);
    expect(await deps.readReceipt(path)).toBeUndefined();
    await deps.deleteReceipt(path);
  });

  it("reports unreadable and non-file receipt stores through concrete dependencies", async () => {
    const values = fixture();
    const deps = createDefaultTokenOptimizerDeps({ runner: fakeRunner(() => undefined) });
    const path = tokenOptimizerReceiptPath(values.project);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not-json\n", "utf8");
    await expect(deps.readReceipt(path)).rejects.toThrow(/receipt is unreadable/i);

    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });
    await expect(deps.readReceipt(path)).rejects.toThrow(/regular file/i);
    await expect(deps.deleteReceipt(path)).rejects.toThrow(/regular file/i);
  });

  it("configures every supported balanced hook event and writes project-scoped metadata", async () => {
    const values = fixture();
    const pythonExecutable = join(values.root, "external", "python.exe");
    writeExecutable(pythonExecutable);
    const seen: string[][] = [];
    const runner = fakeRunner((argv, options) => {
      seen.push([...argv]);
      expect(options?.cwd).toBe(values.project.canonicalRoot);
      expect(options?.env?.TOKEN_OPTIMIZER_RUNTIME).toBe("codex");
      mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
      writeFileSync(
        hooksPath(values.project),
        `${JSON.stringify(
          {
            ...managedHooks("balanced", values.checkoutRoot, pythonExecutable),
            installer: "project",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { stdout: JSON.stringify({ configured: true }) };
    });
    const deps = createDefaultTokenOptimizerDeps({ runner, pythonExecutable });
    const configured = await deps.configure({
      checkoutRoot: values.checkoutRoot,
      project: values.project,
      profile: "balanced",
      sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("balanced");
    expect(configured.changed).toBe(true);
    expect(configured.ownedPaths).toHaveLength(6);
    const metadata = JSON.parse(readFileSync(integrationPath(values.project), "utf8")) as {
      license: string;
      profile: string;
      report: { runtime: string; scope: string; operation: string };
    };
    expect(metadata).toMatchObject({
      license: "PolyForm-Noncommercial-1.0.0",
      profile: "balanced",
      report: { runtime: "codex", scope: "project", operation: "report" },
    });
  });

  it("preserves existing custom settings across repeated concrete configuration", async () => {
    const values = fixture();
    const pythonExecutable = join(values.root, "external", "python.exe");
    writeExecutable(pythonExecutable);
    const custom = customHook();
    const before = {
      hooks: { Stop: [custom] },
      userSetting: { keep: true },
      nonHookOption: "preserve",
    };
    mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
    writeFileSync(hooksPath(values.project), `${JSON.stringify(before, null, 2)}\n`, "utf8");
    const after = {
      ...managedHooks("quiet", values.checkoutRoot, pythonExecutable),
      hooks: {
        Stop: [
          custom,
          ...((
            managedHooks("quiet", values.checkoutRoot, pythonExecutable).hooks as Record<
              string,
              unknown
            >
          ).Stop as unknown[]),
        ],
      },
      userSetting: { keep: true },
      nonHookOption: "preserve",
    };
    const runner = fakeRunner(() => {
      // 5.13.14 appends wrappers it does not recognize on repeat installation.
      const existing = JSON.parse(readFileSync(hooksPath(values.project), "utf8"));
      const installed = {
        ...existing,
        hooks: {
          Stop: [
            ...(existing.hooks.Stop ?? []),
            managedHook(values.checkoutRoot, pythonExecutable),
          ],
        },
      };
      writeFileSync(hooksPath(values.project), `${JSON.stringify(installed, null, 2)}\n`, "utf8");
      return { stdout: "{}" };
    });
    const deps = createDefaultTokenOptimizerDeps({ runner, pythonExecutable });
    const first = await deps.configure({
      checkoutRoot: values.checkoutRoot,
      project: values.project,
      profile: "quiet",
      sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
    });
    expect(first.changed).toBe(true);
    expect(JSON.parse(readFileSync(hooksPath(values.project), "utf8"))).toEqual(after);

    const second = await deps.configure({
      checkoutRoot: values.checkoutRoot,
      project: values.project,
      profile: "quiet",
      sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      existingReceipt: baseReceipt(values.project, first.ownedPaths),
    });
    expect(second.changed).toBe(false);
    expect(second.ownedPaths).toEqual(first.ownedPaths);
    expect(JSON.parse(readFileSync(hooksPath(values.project), "utf8"))).toEqual(after);

    const retained = readFileSync(hooksPath(values.project));
    const failingDeps = createDefaultTokenOptimizerDeps({
      runner: fakeRunner(() => ({ code: 1 })),
      pythonExecutable,
    });
    await expect(
      failingDeps.configure({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "balanced",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
        existingReceipt: baseReceipt(values.project, second.ownedPaths),
      }),
    ).rejects.toThrow(/hook installer failed/i);
    expect(readFileSync(hooksPath(values.project))).toEqual(retained);
  });

  it.each([
    ["nonzero", { code: 1 }],
    ["spawn error", { spawnError: true }],
    ["truncated output", { truncated: true }],
  ] as const)("rejects a concrete hook installer with %s process status", async (_name, status) => {
    const values = fixture();
    const pythonExecutable = join(values.root, "external-python.exe");
    writeExecutable(pythonExecutable);
    const deps = createDefaultTokenOptimizerDeps({
      runner: fakeRunner(() => status),
      pythonExecutable,
    });
    await expect(
      deps.configure({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      }),
    ).rejects.toThrow(/hook installer failed/i);
    expect(existsSync(integrationPath(values.project))).toBe(false);
  });

  it("rejects installer output that omits hooks or managed Token Optimizer groups", async () => {
    for (const output of [undefined, JSON.stringify({ hooks: { Stop: [customHook()] } })]) {
      const values = fixture();
      const pythonExecutable = join(values.root, "external-python.exe");
      writeExecutable(pythonExecutable);
      const deps = createDefaultTokenOptimizerDeps({
        runner: fakeRunner(() => {
          if (output !== undefined) {
            mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
            writeFileSync(hooksPath(values.project), `${output}\n`, "utf8");
          }
          return { stdout: "{}" };
        }),
        pythonExecutable,
      });
      await expect(
        deps.configure({
          checkoutRoot: values.checkoutRoot,
          project: values.project,
          profile: "quiet",
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
        }),
      ).rejects.toThrow(output === undefined ? /produced no hooks/i : /produced no managed hooks/i);
    }
  });

  it("requires an ownership receipt before adopting existing Token Optimizer files", async () => {
    const values = fixture();
    const pythonExecutable = join(values.root, "external-python.exe");
    writeExecutable(pythonExecutable);
    mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
    writeFileSync(
      hooksPath(values.project),
      `${JSON.stringify({ hooks: { Stop: [managedHook(values.checkoutRoot, pythonExecutable)] } })}\n`,
      "utf8",
    );
    const runner = fakeRunner(() => {
      throw new Error("runner must not run");
    });
    const deps = createDefaultTokenOptimizerDeps({ runner, pythonExecutable });
    await expect(
      deps.configure({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      }),
    ).rejects.toThrow(/no ownership receipt/i);

    rmSync(hooksPath(values.project), { force: true });
    mkdirSync(dirname(integrationPath(values.project)), { recursive: true });
    writeFileSync(integrationPath(values.project), "existing integration\n", "utf8");
    await expect(
      deps.configure({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      }),
    ).rejects.toThrow(/existing Token Optimizer integration has no ownership receipt/i);
  });

  it("rejects unsupported concrete hook profiles, events, shapes, and commands", async () => {
    const scenarios: Array<{
      name: string;
      hooks: (values: ReturnType<typeof fixture>, pythonExecutable: string) => unknown;
      python?: (values: ReturnType<typeof fixture>) => string;
      message: RegExp;
    }> = [
      {
        name: "unexpected balanced profile",
        hooks: (values, pythonExecutable) =>
          managedHooks("balanced", values.checkoutRoot, pythonExecutable),
        message: /unexpected hook profile/i,
      },
      {
        name: "unexpected hook event",
        hooks: (values, pythonExecutable) => ({
          hooks: {
            SessionStart: [
              managedHookForEvent("SessionStart", values.checkoutRoot, pythonExecutable),
            ],
          },
        }),
        message: /unexpected hook event/i,
      },
      {
        name: "primitive managed hook group",
        hooks: () => ({ hooks: { Stop: ["token-optimizer/scripts"] } }),
        message: /invalid hook group/i,
      },
      {
        name: "empty managed hook list",
        hooks: () => ({ hooks: { Stop: [{ marker: "token-optimizer/scripts", hooks: [] }] } }),
        message: /invalid hook list/i,
      },
      {
        name: "null command hook",
        hooks: () => ({ hooks: { Stop: [{ marker: "token-optimizer/scripts", hooks: [null] }] } }),
        message: /invalid command hook/i,
      },
      {
        name: "unsupported hook type",
        hooks: (values, pythonExecutable) => {
          const valid = managedHookForEvent("Stop", values.checkoutRoot, pythonExecutable);
          const command = (valid.hooks as Array<Record<string, unknown>>)[0]?.command;
          return {
            hooks: {
              Stop: [{ hooks: [{ type: "prompt", command }] }],
            },
          };
        },
        message: /unsupported hook type/i,
      },
      {
        name: "duplicate marker command",
        hooks: (values, pythonExecutable) => {
          const valid = managedHookForEvent("Stop", values.checkoutRoot, pythonExecutable);
          const command = (valid.hooks as Array<Record<string, unknown>>)[0]?.command;
          return {
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `${String(command ?? "")} token-optimizer/scripts`,
                    },
                  ],
                },
              ],
            },
          };
        },
        message: /invalid hook command/i,
      },
      {
        name: "foreign checkout root",
        hooks: (values, pythonExecutable) =>
          managedHooks("quiet", join(values.root, "foreign-checkout"), pythonExecutable),
        message: /invalid hook command/i,
      },
      {
        name: "checkout path prefix impostor",
        hooks: (values, pythonExecutable) =>
          managedHooks("quiet", `${values.checkoutRoot}-impostor`, pythonExecutable),
        message: /invalid hook command/i,
      },
      {
        name: "shell command suffix",
        hooks: (values, pythonExecutable) => {
          const valid = managedHookForEvent("Stop", values.checkoutRoot, pythonExecutable);
          const command = (valid.hooks as Array<Record<string, unknown>>)[0]?.command;
          return {
            hooks: {
              Stop: [
                {
                  hooks: [
                    { type: "command", command: `${String(command ?? "")} && echo injected` },
                  ],
                },
              ],
            },
          };
        },
        message: /invalid hook command/i,
      },
      {
        name: "selected Python mismatch",
        hooks: (values) =>
          managedHooks("quiet", values.checkoutRoot, join(values.root, "other.exe")),
        message: /did not use the selected Python/i,
      },
      {
        name: "selected Python path prefix impostor",
        hooks: (values, pythonExecutable) =>
          managedHooks("quiet", values.checkoutRoot, `${pythonExecutable}-impostor`),
        message: /did not use the selected Python/i,
      },
      {
        name: "relative Python override",
        hooks: (values) => managedHooks("quiet", values.checkoutRoot, "relative-python"),
        python: () => "relative-python",
        message: /Python executable must be absolute/i,
      },
    ];

    for (const scenario of scenarios) {
      const values = fixture();
      const selectedPython = join(values.root, "selected-python.exe");
      writeExecutable(selectedPython);
      const pythonOverride = scenario.python?.(values) ?? selectedPython;
      const hooks = scenario.hooks(values, selectedPython);
      const deps = createDefaultTokenOptimizerDeps({
        runner: fakeRunner(() => {
          mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
          writeFileSync(hooksPath(values.project), `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
          return { stdout: "{}" };
        }),
        pythonExecutable: pythonOverride,
      });
      await expect(
        deps.configure({
          checkoutRoot: values.checkoutRoot,
          project: values.project,
          profile: "quiet",
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
        }),
      ).rejects.toThrow(scenario.message);
      expect(existsSync(integrationPath(values.project)), scenario.name).toBe(false);
    }
  });

  it("rejects an existing integration that is not receipt-owned and restores changed settings", async () => {
    const values = fixture();
    const pythonExecutable = join(values.root, "selected-python.exe");
    writeExecutable(pythonExecutable);
    mkdirSync(dirname(integrationPath(values.project)), { recursive: true });
    writeFileSync(integrationPath(values.project), "existing integration\n", "utf8");
    const integrationBytes = readFileSync(integrationPath(values.project));
    const deps = createDefaultTokenOptimizerDeps({
      runner: fakeRunner(() => {
        throw new Error("runner must not run");
      }),
      pythonExecutable,
    });
    await expect(
      deps.configure({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
        existingReceipt: baseReceipt(values.project, [
          {
            path: integrationPath(values.project),
            sha256: "a".repeat(64),
            ownership: "file",
          },
        ]),
      }),
    ).rejects.toThrow(/not receipt-owned/i);
    expect(readFileSync(integrationPath(values.project))).toEqual(integrationBytes);

    rmSync(integrationPath(values.project), { force: true });
    const before = {
      hooks: { Stop: [customHook()] },
      userSetting: "keep",
    };
    mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
    const beforeBytes = Buffer.from(`${JSON.stringify(before, null, 2)}\n`, "utf8");
    writeFileSync(hooksPath(values.project), beforeBytes);
    const changedAfter = {
      ...managedHooks("quiet", values.checkoutRoot, pythonExecutable),
      hooks: managedHooks("quiet", values.checkoutRoot, pythonExecutable).hooks,
      userSetting: "changed",
    };
    const changedDeps = createDefaultTokenOptimizerDeps({
      runner: fakeRunner(() => {
        writeFileSync(
          hooksPath(values.project),
          `${JSON.stringify(changedAfter, null, 2)}\n`,
          "utf8",
        );
        return { stdout: "{}" };
      }),
      pythonExecutable,
    });
    await expect(
      changedDeps.configure({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      }),
    ).rejects.toThrow(/changed existing setting userSetting/i);
    expect(readFileSync(hooksPath(values.project))).toEqual(beforeBytes);
  });

  it("converts acquisition, configuration, receipt, and verifier failures into blocked results", async () => {
    const cases: Array<{
      name: string;
      configure?: (values: ReturnType<typeof fixture>) => Promise<TokenOptimizerConfigureResult>;
      verify?: () => Promise<{ ok: boolean; detail: string }>;
      writeReceipt?: () => Promise<void>;
      acquire?: (values: ReturnType<typeof fixture>) => Promise<unknown>;
      expected: RegExp;
    }> = [
      {
        name: "acquisition exception",
        acquire: async () => {
          throw new Error("network unavailable");
        },
        expected: /acquisition was blocked.*network unavailable/i,
      },
      {
        name: "configuration exception",
        acquire: async (values) => ({
          checkoutRoot: values.checkoutRoot,
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
          reused: false,
        }),
        configure: async () => {
          throw new Error("installer unavailable");
        },
        expected: /configuration was blocked.*installer unavailable/i,
      },
      {
        name: "invalid configuration result",
        acquire: async (values) => ({
          checkoutRoot: values.checkoutRoot,
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
          reused: true,
        }),
        configure: async () => ({}) as never,
        expected: /configuration was blocked.*invalid configuration result/i,
      },
      {
        name: "invalid verifier result",
        acquire: async (values) => ({
          checkoutRoot: values.checkoutRoot,
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
          reused: true,
        }),
        configure: async (values) => configuredResult(values.project, values.checkoutRoot, false),
        verify: async () => undefined as never,
        expected: /verification was blocked.*invalid result/i,
      },
      {
        name: "receipt persistence exception",
        acquire: async (values) => ({
          checkoutRoot: values.checkoutRoot,
          sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
          reused: true,
        }),
        configure: async (values) => configuredResult(values.project, values.checkoutRoot, false),
        writeReceipt: async () => {
          throw { reason: "receipt persistence unavailable" };
        },
        expected: /ownership receipt could not be persisted.*prerequisite failed/i,
      },
    ];

    for (const scenario of cases) {
      const values = fixture();
      const result = await reconcileTokenOptimizer(
        {
          project: values.project,
          installRoot: values.installRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        },
        {
          acquire:
            scenario.acquire === undefined
              ? async () => ({
                  checkoutRoot: values.checkoutRoot,
                  sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
                  reused: true,
                })
              : async () => scenario.acquire?.(values) as never,
          configure:
            scenario.configure === undefined
              ? async () => configuredResult(values.project, values.checkoutRoot, false)
              : async () => scenario.configure?.(values) as never,
          verifyRuntime:
            scenario.verify === undefined
              ? async () => ({ ok: true, detail: "unused" })
              : async () => scenario.verify?.() as never,
          writeReceipt: scenario.writeReceipt,
          readReceipt: async () => undefined,
        },
      );
      expect(result.state, scenario.name).toBe("blocked");
      expect(result.detail, scenario.name).toMatch(scenario.expected);
    }
  });

  it("validates configured ownership claims against real integration and hook content", async () => {
    const cases: Array<{
      name: string;
      configure: (values: ReturnType<typeof fixture>) => Promise<TokenOptimizerConfigureResult>;
      expected: RegExp;
    }> = [
      {
        name: "missing integration claim",
        configure: async () => ({ ownedPaths: [], detail: "configured", changed: false }),
        expected: /integration receipt does not match/i,
      },
      {
        name: "missing configured hooks",
        configure: async (values) => {
          const bytes = Buffer.from('{"profile":"quiet"}\n', "utf8");
          mkdirSync(dirname(integrationPath(values.project)), { recursive: true });
          writeFileSync(integrationPath(values.project), bytes);
          return {
            ownedPaths: [
              { path: integrationPath(values.project), sha256: sha256(bytes), ownership: "file" },
            ],
            detail: "configured",
            changed: false,
          };
        },
        expected: /configured hooks are missing/i,
      },
      {
        name: "missing managed ownership digest",
        configure: async (values) => {
          const owned = managedOwnedPaths(values.project, values.checkoutRoot);
          return {
            ownedPaths: owned.filter((claim) => claim.ownership === "file"),
            detail: "configured",
            changed: false,
          };
        },
        expected: /configured hooks do not match/i,
      },
      {
        name: "wrong managed ownership digest",
        configure: async (values) => {
          const owned = managedOwnedPaths(values.project, values.checkoutRoot);
          return {
            ownedPaths: owned.map((claim) =>
              claim.ownership === "managed-block" ? { ...claim, sha256: "b".repeat(64) } : claim,
            ),
            detail: "configured",
            changed: false,
          };
        },
        expected: /configured hooks do not match/i,
      },
    ];

    for (const scenario of cases) {
      const values = fixture();
      const result = await reconcileTokenOptimizer(
        {
          project: values.project,
          installRoot: values.installRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        },
        {
          acquire: async () => ({
            checkoutRoot: values.checkoutRoot,
            sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
            reused: true,
          }),
          configure: () => scenario.configure(values),
          verifyRuntime: async () => ({ ok: true, detail: "must not verify" }),
          readReceipt: async () => undefined,
        },
      );
      expect(result.state, scenario.name).toBe("blocked");
      expect(result.detail, scenario.name).toMatch(scenario.expected);
    }
  });

  it("cleans receipt claims whose files or hook settings are already absent", async () => {
    const values = fixture();
    const hooks = hooksPath(values.project);
    const receipt = baseReceipt(values.project, [
      { path: integrationPath(values.project), sha256: "a".repeat(64), ownership: "file" },
      { path: hooks, sha256: "b".repeat(64), ownership: "managed-block" },
    ]);
    let deleted = false;
    const result = await reconcileTokenOptimizer(
      {
        project: values.project,
        installRoot: values.installRoot,
        selected: false,
        acceptLicense: true,
        profile: "quiet",
      },
      {
        readReceipt: async () => receipt,
        deleteReceipt: async () => {
          deleted = true;
        },
      },
    );
    expect(result).toMatchObject({ state: "policy-excluded", changed: true });
    expect(deleted).toBe(true);
    expect(existsSync(integrationPath(values.project))).toBe(false);
    expect(existsSync(hooks)).toBe(false);
  });

  it("discovers curl from an external PATH and fails before git when no governed executable exists", async () => {
    const values = fixture();
    const bin = join(values.root, "external-tools");
    externalBin(bin, "git");
    const curlExecutable = externalBin(bin, "curl");
    const runner = fakeRunner((argv) => {
      if (argv.includes("HEAD^{tree}")) return { stdout: `${TOKEN_OPTIMIZER_PIN.tree}\n` };
      if (argv.includes(`${TOKEN_OPTIMIZER_PIN.tag}^{commit}`)) {
        return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      }
      if (argv.includes("HEAD")) return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      if (argv.includes("core.autocrlf")) return { stdout: "false\n" };
      if (argv.includes("core.eol")) return { stdout: "lf\n" };
      return { stdout: "unqualified manifest\n" };
    });
    await expect(
      withPath(bin, async () => {
        const deps = createDefaultTokenOptimizerDeps({ runner });
        return deps.acquire({ installRoot: values.installRoot, source: TOKEN_OPTIMIZER_PIN });
      }),
    ).rejects.toThrow(/manifest identity mismatch/i);
    expect(realpathSync.native(curlExecutable).toLowerCase()).toContain(
      "\\external-tools\\curl.exe",
    );

    const missingValues = fixture();
    const emptyPath = join(missingValues.root, "empty-path");
    await expect(
      withPath(emptyPath, async () => {
        const deps = createDefaultTokenOptimizerDeps({ runner: fakeRunner(() => undefined) });
        return deps.acquire({
          installRoot: missingValues.installRoot,
          source: TOKEN_OPTIMIZER_PIN,
        });
      }),
    ).rejects.toThrow(/git executable is unavailable/i);
  });

  it("surfaces malformed hook JSON through the concrete configuration boundary", async () => {
    const values = fixture();
    const pythonExecutable = join(values.root, "selected-python.exe");
    writeExecutable(pythonExecutable);
    mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
    writeFileSync(hooksPath(values.project), "{malformed\n", "utf8");
    const malformedDeps = createDefaultTokenOptimizerDeps({
      runner: fakeRunner(() => {
        throw new Error("runner must not run");
      }),
      pythonExecutable,
    });
    await expect(
      malformedDeps.configure({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      }),
    ).rejects.toThrow(/hooks configuration is unreadable/i);
  });

  it("rejects malformed acquisition and configuration callback results without running later stages", async () => {
    const acquisitionCases: unknown[] = [
      {},
      { checkoutRoot: "relative", sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST, reused: false },
      {
        checkoutRoot: "C:/missing-checkout",
        sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
        reused: false,
      },
      { checkoutRoot: "C:/tmp", sourceDigest: "", reused: false },
      { checkoutRoot: "C:/tmp", sourceDigest: "ok", reused: "no" },
    ];
    for (const acquisition of acquisitionCases) {
      const values = fixture();
      let configured = 0;
      const result = await reconcileTokenOptimizer(
        {
          project: values.project,
          installRoot: values.installRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        },
        {
          acquire: async () => acquisition as never,
          configure: async () => {
            configured += 1;
            return configuredResult(values.project, values.checkoutRoot, true);
          },
          readReceipt: async () => undefined,
        },
      );
      expect(result.state).toBe("blocked");
      expect(result.detail).toMatch(/acquisition was blocked/i);
      expect(configured).toBe(0);
    }

    const configurationCases: unknown[] = [
      { changed: true, detail: "", ownedPaths: [] },
      { changed: true, detail: "configured", ownedPaths: "not-an-array" },
      { changed: "yes", detail: "configured", ownedPaths: [] },
      {
        changed: true,
        detail: "configured",
        ownedPaths: [{ path: "relative", sha256: "a".repeat(64), ownership: "file" }],
      },
    ];
    for (const configuration of configurationCases) {
      const values = fixture();
      let verified = 0;
      const result = await reconcileTokenOptimizer(
        {
          project: values.project,
          installRoot: values.installRoot,
          selected: true,
          acceptLicense: true,
          profile: "quiet",
        },
        {
          acquire: async () => ({
            checkoutRoot: values.checkoutRoot,
            sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
            reused: true,
          }),
          configure: async () => configuration as never,
          verifyRuntime: async () => {
            verified += 1;
            return { ok: true, detail: "must not verify" };
          },
          readReceipt: async () => undefined,
        },
      );
      expect(result.state).toBe("blocked");
      expect(result.detail).toMatch(/configuration was blocked/i);
      expect(verified).toBe(0);
    }
  });

  it("authenticates a cached checkout with hermetic git and rejects an unqualified release manifest", async () => {
    const values = fixture();
    const bin = join(values.root, "external-tools");
    externalBin(bin, "git");
    const curlExecutable = externalBin(bin, "curl");
    const seen: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = fakeRunner((argv, options) => {
      seen.push({ argv: [...argv], env: options?.env });
      if (argv.includes("HEAD^{tree}")) return { stdout: `${TOKEN_OPTIMIZER_PIN.tree}\n` };
      if (argv.includes(`${TOKEN_OPTIMIZER_PIN.tag}^{commit}`)) {
        return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      }
      if (argv.includes("HEAD")) return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      if (argv.includes("core.autocrlf")) return { stdout: "false\n" };
      if (argv.includes("core.eol")) return { stdout: "lf\n" };
      if (argv.some((argument) => argument.includes("CHECKSUMS.sha256"))) {
        return { stdout: "not the pinned manifest\n" };
      }
      return { stdout: "" };
    });

    await expect(
      withPath(bin, async () => {
        const deps = createDefaultTokenOptimizerDeps({ runner, curlExecutable });
        return deps.acquire({ installRoot: values.installRoot, source: TOKEN_OPTIMIZER_PIN });
      }),
    ).rejects.toThrow(/manifest identity mismatch/i);
    expect(seen.filter((call) => call.argv.includes("-C"))).toHaveLength(5);
    expect(seen.at(-1)?.argv[0]).toBe(curlExecutable);
    for (const call of seen.filter((entry) => entry.argv.includes("-C"))) {
      expect(call.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(call.env?.GIT_DIR).toBeUndefined();
      expect(call.env?.GIT_INDEX_FILE).toBeUndefined();
    }
  });

  it("removes a failed staging checkout when the pinned clone cannot start", async () => {
    const values = fixture();
    rmSync(values.checkoutRoot, { recursive: true, force: true });
    const bin = join(values.root, "external-tools");
    externalBin(bin, "git");
    const curlExecutable = externalBin(bin, "curl");
    const runner = fakeRunner((argv) =>
      argv.includes("clone") ? { code: 1, stderr: "clone unavailable" } : undefined,
    );

    await withPath(bin, async () => {
      const deps = createDefaultTokenOptimizerDeps({ runner, curlExecutable });
      await expect(
        deps.acquire({ installRoot: values.installRoot, source: TOKEN_OPTIMIZER_PIN }),
      ).rejects.toThrow(/git clone failed/i);
    });

    expect(existsSync(values.checkoutRoot)).toBe(false);
    expect(readdirSync(values.installRoot).filter((name) => name.includes("staging"))).toEqual([]);
  });

  it("parses the exact 158-record release manifest before rejecting a tampered checkout blob", async () => {
    const values = fixture();
    const firstManifestPath = join(values.checkoutRoot, ".claude-plugin", "marketplace.json");
    writeExecutable(firstManifestPath, "tampered checkout content\n");
    const bin = join(values.root, "external-tools");
    externalBin(bin, "git");
    const curlExecutable = externalBin(bin, "curl");
    const seen: string[][] = [];
    const runner = fakeRunner((argv) => {
      seen.push([...argv]);
      if (argv.includes("HEAD^{tree}")) return { stdout: `${TOKEN_OPTIMIZER_PIN.tree}\n` };
      if (argv.includes(`${TOKEN_OPTIMIZER_PIN.tag}^{commit}`)) {
        return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      }
      if (argv.includes("HEAD")) return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      if (argv.includes("core.autocrlf")) return { stdout: "false\n" };
      if (argv.includes("core.eol")) return { stdout: "lf\n" };
      if (argv.some((argument) => argument.includes("CHECKSUMS.sha256"))) {
        return { stdout: PINNED_RELEASE_MANIFEST };
      }
      return undefined;
    });

    expect(sha256(PINNED_RELEASE_MANIFEST)).toBe(TOKEN_OPTIMIZER_PIN.manifestSha256);
    await expect(
      withPath(bin, async () => {
        const deps = createDefaultTokenOptimizerDeps({ runner, curlExecutable });
        return deps.acquire({ installRoot: values.installRoot, source: TOKEN_OPTIMIZER_PIN });
      }),
    ).rejects.toThrow(/manifest content mismatch/i);
    expect(seen.filter((argv) => argv.includes("-C"))).toHaveLength(5);
    expect(seen.at(-1)?.some((argument) => argument.includes("CHECKSUMS.sha256"))).toBe(true);
  });

  it("fails closed for a stale cached directory and for a non-qualified source pin", async () => {
    const values = fixture();
    const bin = join(values.root, "external-tools");
    const gitExecutable = externalBin(bin, "git");
    const curlExecutable = externalBin(bin, "curl");
    const deps = createDefaultTokenOptimizerDeps({
      runner: fakeRunner(() => undefined),
      curlExecutable,
    });
    rmSync(values.checkoutRoot, { recursive: true, force: true });
    writeFileSync(values.checkoutRoot, "cache path occupied by a file\n", "utf8");
    await withPath(bin, async () => {
      await expect(
        deps.acquire({ installRoot: values.installRoot, source: TOKEN_OPTIMIZER_PIN }),
      ).rejects.toThrow(/cache is not a directory/i);
    });

    rmSync(values.checkoutRoot, { force: true });
    const unqualified = { ...TOKEN_OPTIMIZER_PIN, commit: "0".repeat(40) };
    await expect(
      deps.acquire({
        installRoot: values.installRoot,
        source: unqualified as typeof TOKEN_OPTIMIZER_PIN,
      }),
    ).rejects.toThrow(/qualified immutable pin/i);
    expect(gitExecutable).toContain("git");
  });

  it.each([
    ["HEAD", "wrong-head", /commit identity mismatch/i],
    ["tag", "wrong-tag", /tag identity mismatch/i],
    ["tree", "wrong-tree", /tree identity mismatch/i],
    ["autocrlf", "true", /EOL conversion is enabled/i],
    ["eol", "crlf", /EOL policy is not LF/i],
  ] as const)(
    "rejects a cached checkout with a mismatched %s identity",
    async (kind, value, message) => {
      const values = fixture();
      const bin = join(values.root, `external-tools-${kind}`);
      externalBin(bin, "git");
      const curlExecutable = externalBin(bin, "curl");
      const runner = fakeRunner((argv) => {
        if (argv.includes("HEAD^{tree}")) {
          return { stdout: `${kind === "tree" ? value : TOKEN_OPTIMIZER_PIN.tree}\n` };
        }
        if (argv.includes(`${TOKEN_OPTIMIZER_PIN.tag}^{commit}`)) {
          return { stdout: `${kind === "tag" ? value : TOKEN_OPTIMIZER_PIN.commit}\n` };
        }
        if (argv.includes("HEAD")) {
          return { stdout: `${kind === "HEAD" ? value : TOKEN_OPTIMIZER_PIN.commit}\n` };
        }
        if (argv.includes("core.autocrlf"))
          return { stdout: `${kind === "autocrlf" ? value : "false"}\n` };
        if (argv.includes("core.eol")) return { stdout: `${kind === "eol" ? value : "lf"}\n` };
        return { stdout: "unused" };
      });
      await expect(
        withPath(bin, async () => {
          const deps = createDefaultTokenOptimizerDeps({ runner, curlExecutable });
          return deps.acquire({ installRoot: values.installRoot, source: TOKEN_OPTIMIZER_PIN });
        }),
      ).rejects.toThrow(message);
    },
  );

  it("cleans a staging checkout when post-clone authentication fails", async () => {
    const values = fixture();
    rmSync(values.checkoutRoot, { recursive: true, force: true });
    const bin = join(values.root, "external-tools-post-clone");
    externalBin(bin, "git");
    const curlExecutable = externalBin(bin, "curl");
    const runner = fakeRunner((argv) => {
      if (argv.includes("clone")) return undefined;
      if (argv.includes("HEAD^{tree}")) return { stdout: `${TOKEN_OPTIMIZER_PIN.tree}\n` };
      if (argv.includes(`${TOKEN_OPTIMIZER_PIN.tag}^{commit}`)) {
        return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      }
      if (argv.includes("HEAD")) return { stdout: `${TOKEN_OPTIMIZER_PIN.commit}\n` };
      if (argv.includes("core.autocrlf")) return { stdout: "false\n" };
      if (argv.includes("core.eol")) return { stdout: "lf\n" };
      return { stdout: "bad manifest\n" };
    });
    await expect(
      withPath(bin, async () => {
        const deps = createDefaultTokenOptimizerDeps({ runner, curlExecutable });
        return deps.acquire({ installRoot: values.installRoot, source: TOKEN_OPTIMIZER_PIN });
      }),
    ).rejects.toThrow(/manifest identity mismatch/i);
    expect(existsSync(values.checkoutRoot)).toBe(false);
    expect(readdirSync(values.installRoot).filter((name) => name.includes("staging"))).toEqual([]);
  });

  it("reports concrete verifier failures for missing hooks, failed reports, empty reports, and launcher errors", async () => {
    const scenarios: Array<{
      name: string;
      prepare: (values: ReturnType<typeof fixture>, pythonExecutable: string) => void;
      run: (argv: string[]) => { code?: number; stdout?: string; spawnError?: boolean };
      detail: RegExp;
    }> = [
      {
        name: "missing hooks",
        prepare: () => undefined,
        run: () => ({ stdout: "unexpected" }),
        detail: /hooks are missing/i,
      },
      {
        name: "offline report failure",
        prepare: (values, pythonExecutable) => {
          mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
          writeFileSync(
            hooksPath(values.project),
            `${JSON.stringify(managedHooks("quiet", values.checkoutRoot, pythonExecutable), null, 2)}\n`,
            "utf8",
          );
        },
        run: (argv) => (argv.includes("report") ? { code: 1 } : { stdout: "hook ok" }),
        detail: /offline report command failed/i,
      },
      {
        name: "empty offline report",
        prepare: (values, pythonExecutable) => {
          mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
          writeFileSync(
            hooksPath(values.project),
            `${JSON.stringify(managedHooks("quiet", values.checkoutRoot, pythonExecutable), null, 2)}\n`,
            "utf8",
          );
        },
        run: (argv) => (argv.includes("report") ? { stdout: "   " } : { stdout: "hook ok" }),
        detail: /returned no report/i,
      },
      {
        name: "runner exception",
        prepare: (values, pythonExecutable) => {
          mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
          writeFileSync(
            hooksPath(values.project),
            `${JSON.stringify(managedHooks("quiet", values.checkoutRoot, pythonExecutable), null, 2)}\n`,
            "utf8",
          );
        },
        run: () => {
          throw new Error("offline runner unavailable");
        },
        detail: /could not be executed/i,
      },
    ];

    for (const scenario of scenarios) {
      const values = fixture();
      const pythonExecutable = join(values.root, "external-python.exe");
      writeExecutable(pythonExecutable);
      scenario.prepare(values, pythonExecutable);
      const deps = createDefaultTokenOptimizerDeps({
        runner: fakeRunner((argv) => scenario.run(argv)),
        pythonExecutable,
      });
      const result = await deps.verifyRuntime({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
      });
      expect(result.ok, scenario.name).toBe(false);
      expect(result.detail, scenario.name).toMatch(scenario.detail);
    }
  });

  it("verifies all balanced hook events through the actual configured command", async () => {
    const values = fixture();
    const pythonExecutable = join(values.root, "external-python.exe");
    writeExecutable(pythonExecutable);
    mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
    writeFileSync(
      hooksPath(values.project),
      `${JSON.stringify(managedHooks("balanced", values.checkoutRoot, pythonExecutable), null, 2)}\n`,
      "utf8",
    );
    const calls: string[][] = [];
    const deps = createDefaultTokenOptimizerDeps({
      runner: fakeRunner((argv, options) => {
        calls.push([...argv]);
        expect(options?.cwd).toBe(values.project.canonicalRoot);
        expect(options?.env?.TOKEN_OPTIMIZER_RUNTIME).toBe("codex");
        return { stdout: argv.includes("report") ? "offline report" : "hook completed" };
      }),
      pythonExecutable,
    });
    const result = await deps.verifyRuntime({
      checkoutRoot: values.checkoutRoot,
      project: values.project,
      profile: "balanced",
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      process.platform === "win32"
        ? pythonExecutable
        : join(values.checkoutRoot, "hooks", "python-launcher.sh"),
      join(values.checkoutRoot, "hooks", "run.py"),
      "hooks/stop_runner.py",
    ]);
    expect(calls[1]).toEqual([
      pythonExecutable,
      join(values.checkoutRoot, "skills", "token-optimizer", "scripts", "measure.py"),
      "report",
    ]);
  });

  it("fails closed when concrete verification cannot discover an external Python or launcher", async () => {
    const values = fixture();
    const launcher = join(values.checkoutRoot, "hooks", "python-launcher.sh");
    const pythonExecutable = join(values.root, "external-python.exe");
    writeExecutable(pythonExecutable);
    mkdirSync(dirname(hooksPath(values.project)), { recursive: true });
    writeFileSync(
      hooksPath(values.project),
      `${JSON.stringify(managedHooks("quiet", values.checkoutRoot, pythonExecutable), null, 2)}\n`,
      "utf8",
    );
    if (process.platform !== "win32") chmodSync(launcher, 0o644);
    const noPython = await withPath(join(values.root, "empty-path"), async () => {
      const deps = createDefaultTokenOptimizerDeps({ runner: fakeRunner(() => undefined) });
      return deps.verifyRuntime({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
      });
    });
    expect(noPython.ok).toBe(false);
    expect(noPython.detail).toMatch(/could not be executed/i);

    if (process.platform !== "win32") {
      const deps = createDefaultTokenOptimizerDeps({
        runner: fakeRunner(() => ({ stdout: "unused" })),
        pythonExecutable,
      });
      const noLauncher = await deps.verifyRuntime({
        checkoutRoot: values.checkoutRoot,
        project: values.project,
        profile: "quiet",
      });
      expect(noLauncher.ok).toBe(false);
      expect(noLauncher.detail).toMatch(/could not be executed/i);
    }
  });
});
