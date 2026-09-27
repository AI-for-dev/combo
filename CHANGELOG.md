# Changelog

## [0.2.0](https://github.com/AI-for-dev/combo/compare/v0.1.1...v0.2.0) (2026-09-27)


### ⚠ BREAKING CHANGES

* the linear pipeline is removed. Gone from the package root: checkPipelineAgents, findPipeline, loadPipelines, lookupPipeline, parsePipeline, runPipeline, stepInput and their types (BrokenPipeline, Pipeline, PipelineCatalogue, PipelineRunOptions, PipelineRunResult, PipelineStep, PipelineStepResult, StepKind); deliver, pair, audit and APPROVAL with their option, result and progress types; BuildState, BUILD_STATE_VERSION, findResumableBuild, fromBuildState, missingAgents, saveBuildState and toBuildState; Settling and SettleOptions; commandVerifier, Verify, Verification and CommandVerifierOptions; the review types Verdict, VerdictTool, Resolution, Ledger, CloseOutcome, ReviewRecord, ReviewRecordOptions, ReviewRound and ProseApproval. land loses its verify option and Landed its checks. Gone from the tree: src/pipeline/, src/workflows/deliver/, pipelines/ (and "pipelines" in the package's files), .pi/pipelines/ and docs/guide/pipelines.md.
* **flow:** /step no longer runs pipelines and loses --worktree; a stage names a flow or an agent, and a flow's copies are its file's.
* **flow:** `/build` is replaced by `/run build`, and `/run` runs flows. `/build`'s flags, `/build resume` and `build.json` are gone; `/run resume` carries a flow run on from its journal.
* **flow:** /pipelines is replaced by /flows.

### Features

* **board:** let a post answer another, in public ([#192](https://github.com/AI-for-dev/combo/issues/192)) ([fe50b36](https://github.com/AI-for-dev/combo/commit/fe50b36ff688f7ff527c1e944b56d4dd1ae3f107))
* **examples:** hand each debater its camp, and debate by answering posts ([#193](https://github.com/AI-for-dev/combo/issues/193)) ([7e1b497](https://github.com/AI-for-dev/combo/commit/7e1b4970cde057946be14817920a9b181f45a728))
* **extension:** the question card honours a flow's Asking ([#155](https://github.com/AI-for-dev/combo/issues/155)) ([0594115](https://github.com/AI-for-dev/combo/commit/05941159225bab4b6cbadcdc93103836aa4d36b6))
* **flow:** /step and the subagent tool take flows ([#158](https://github.com/AI-for-dev/combo/issues/158)) ([3216daf](https://github.com/AI-for-dev/combo/commit/3216daf47d034ec5ff809a6b0d85ad52e52f7a59))
* **flow:** ask a person, in three forms, with what not answering gives ([#146](https://github.com/AI-for-dev/combo/issues/146)) ([3bff335](https://github.com/AI-for-dev/combo/commit/3bff3359dd42ac0f9d24ff84b4b041d34f440c8d))
* **flow:** call a flow from a flow ([#147](https://github.com/AI-for-dev/combo/issues/147)) ([735ce9e](https://github.com/AI-for-dev/combo/commit/735ce9e7dccc32f5f8622bdba624d7e321351410))
* **flow:** check a loop, its carry, its ledger and its verdicts ([#139](https://github.com/AI-for-dev/combo/issues/139)) ([a9f791e](https://github.com/AI-for-dev/combo/commit/a9f791e0325cc8124c1c5309cb1ecefe48f8e9b2))
* **flow:** check a run against its project, and run check nodes ([#144](https://github.com/AI-for-dev/combo/issues/144)) ([68c7637](https://github.com/AI-for-dev/combo/commit/68c763780b9db1cd563b0df8fe23b9de693081ea))
* **flow:** check the blocks that branch: choice, parallel and map ([#138](https://github.com/AI-for-dev/combo/issues/138)) ([255fcda](https://github.com/AI-for-dev/combo/commit/255fcdab7a9808c5f79d17fddd6c7507a1a4972c))
* **flow:** commit on the run's branch, read diff, and run branches in copies ([#145](https://github.com/AI-for-dev/combo/issues/145)) ([6dcd769](https://github.com/AI-for-dev/combo/commit/6dcd76949fb6d18559527661f910d9b6e7721fb3))
* **flow:** compute a checked flow's bounds, and render it as a plan and a Mermaid diagram ([#151](https://github.com/AI-for-dev/combo/issues/151)) ([bf3a56a](https://github.com/AI-for-dev/combo/commit/bf3a56a2e9a474e4c0ae6e982aeaaef4ea7087fd))
* **flow:** end the shipped build with a short report ([#163](https://github.com/AI-for-dev/combo/issues/163)) ([e2de17b](https://github.com/AI-for-dev/combo/commit/e2de17b96411d15c0f2ab58d8424f667e68a9b28))
* **flow:** export the flow API, and list flows with /flows ([#156](https://github.com/AI-for-dev/combo/issues/156)) ([e839d67](https://github.com/AI-for-dev/combo/commit/e839d67dfdb3b45aa04b8472c246f0b12588ce6e))
* **flow:** keep a run's snapshot and journal in its run directory ([#148](https://github.com/AI-for-dev/combo/issues/148)) ([9b527a9](https://github.com/AI-for-dev/combo/commit/9b527a9bf9b42abab548e81cd2e217fb5885533d))
* **flow:** leave each subagent's transcript under its home, and measure a flow run's visits, nodes and lives ([#154](https://github.com/AI-for-dev/combo/issues/154)) ([0972c53](https://github.com/AI-for-dev/combo/commit/0972c535f5b6d25b6cfe35ac526430047391b726))
* **flow:** load a flow's catalogue from disk, and check its agents there ([#140](https://github.com/AI-for-dev/combo/issues/140)) ([7ef665c](https://github.com/AI-for-dev/combo/commit/7ef665cc6d0e7454c4fadad9b74c260c2998a571))
* **flow:** parse, check and evaluate a flow's conditions ([#135](https://github.com/AI-for-dev/combo/issues/135)) ([7d5d823](https://github.com/AI-for-dev/combo/commit/7d5d82372da20b3fe5a796bab4781bedf9fb21a4))
* **flow:** read a flow file and check it against a catalogue ([#137](https://github.com/AI-for-dev/combo/issues/137)) ([b3f10c0](https://github.com/AI-for-dev/combo/commit/b3f10c0be4a9102d15204a5c108d8bfc119c1dc5))
* **flow:** read a node's schema, in the short notation or as JSON Schema ([#136](https://github.com/AI-for-dev/combo/issues/136)) ([b12dedc](https://github.com/AI-for-dev/combo/commit/b12dedcf3ad97b2d43c387e219b72ae5bda4242c))
* **flow:** resume a run from its snapshot and journal, under a lock ([#149](https://github.com/AI-for-dev/combo/issues/149)) ([e5b2c38](https://github.com/AI-for-dev/combo/commit/e5b2c38bc3534244bce217e088f2fd474ce4c44e))
* **flow:** run a checked flow's agent and choice nodes, and dry-run it on a script ([#142](https://github.com/AI-for-dev/combo/issues/142)) ([f38acf9](https://github.com/AI-for-dev/combo/commit/f38acf9170bf47a4818f0c61250a050054cf6481))
* **flow:** run flows with /run, and start the build as /run build ([#157](https://github.com/AI-for-dev/combo/issues/157)) ([4573359](https://github.com/AI-for-dev/combo/commit/4573359c49e63a4fcebce58ac7c3933d9b5ec3cf))
* **flow:** run parallel, map and loop, and write ledgers through verdict nodes ([#143](https://github.com/AI-for-dev/combo/issues/143)) ([6ad2fa1](https://github.com/AI-for-dev/combo/commit/6ad2fa1a85b1cae43c0bdeccadfd48a56a04831e))
* **flows:** ask every agent node of the shipped flows twice ([#175](https://github.com/AI-for-dev/combo/issues/175)) ([d3b0b69](https://github.com/AI-for-dev/combo/commit/d3b0b696e918a3fa2cbc3894ae6cce00a2184012))
* **flow:** ship build, explore, split, interview and build-attended as flows ([#153](https://github.com/AI-for-dev/combo/issues/153)) ([f43e36e](https://github.com/AI-for-dev/combo/commit/f43e36e0c7710baea996039a4367579347296e18))
* **flow:** the live view of a flow run ([#152](https://github.com/AI-for-dev/combo/issues/152)) ([f72a592](https://github.com/AI-for-dev/combo/commit/f72a592e16ede11e6c147f29bc95b01210d877d8))
* remove the linear pipeline ([#160](https://github.com/AI-for-dev/combo/issues/160)) ([c32ff3e](https://github.com/AI-for-dev/combo/commit/c32ff3e7c883fc563b00311a7c038a502c6465ef))
* run /build unattended, and leave the work uncommitted ([#134](https://github.com/AI-for-dev/combo/issues/134)) ([ecfb5cf](https://github.com/AI-for-dev/combo/commit/ecfb5cf32bfe61f84232ed208b7ea048e62c1b7d))
* **swarm:** ask a member's failed turn again once before it drops out ([#191](https://github.com/AI-for-dev/combo/issues/191)) ([eaaac64](https://github.com/AI-for-dev/combo/commit/eaaac64435cb8e06ef9deacc2d319e18996f1ae8))
* **swarm:** cap the results a member posts in one turn ([#190](https://github.com/AI-for-dev/combo/issues/190)) ([c661f90](https://github.com/AI-for-dev/combo/commit/c661f908ae450cd5d72a8cae3bf948c747f130f0))
* the debate example, and a board that refuses a repeated post ([#188](https://github.com/AI-for-dev/combo/issues/188)) ([3b32cd7](https://github.com/AI-for-dev/combo/commit/3b32cd7fd886d43d74bbaacb87fb2e4d214c8fef))


### Bug Fixes

* **agents:** the flow grants the verdict, the reviewer and auditor no longer name it ([#166](https://github.com/AI-for-dev/combo/issues/166)) ([8319266](https://github.com/AI-for-dev/combo/commit/83192669ee2ed07b9c6a496dd5942ac08e205260))
* **deadline:** word a deadline once, the way a flow file writes it ([#181](https://github.com/AI-for-dev/combo/issues/181)) ([034e6bb](https://github.com/AI-for-dev/combo/commit/034e6bb048be5227f62dcaaab47b2241c8cfac0e))
* drop an agent file with invalid YAML frontmatter instead of throwing ([#141](https://github.com/AI-for-dev/combo/issues/141)) ([19ef93d](https://github.com/AI-for-dev/combo/commit/19ef93dea557ce3800d2f81476b2fafa48baf443))
* **extension:** infer orchestrate, and name in each param the modes that read it ([#186](https://github.com/AI-for-dev/combo/issues/186)) ([4605a64](https://github.com/AI-for-dev/combo/commit/4605a648a1e9404f72be77fa188cbec86080248f))
* **extension:** put cards up only in pi's terminal, and run the tool one call at a time ([#159](https://github.com/AI-for-dev/combo/issues/159)) ([0a40a0e](https://github.com/AI-for-dev/combo/commit/0a40a0e5732fe9991b7679e873b2c7963062de02))
* **extension:** refuse a /herdr argument other than on or off ([#184](https://github.com/AI-for-dev/combo/issues/184)) ([5ee9eef](https://github.com/AI-for-dev/combo/commit/5ee9eef5b0db378300fbc215e462fe62195b6895))
* **extension:** refuse a switch or a count written with a value it does not take ([#187](https://github.com/AI-for-dev/combo/issues/187)) ([a4dd528](https://github.com/AI-for-dev/combo/commit/a4dd528a1fdf5dbe8f52635d39de2155266a9c72))
* fail a turn cut by the output limit, and retry every agent node of build ([#174](https://github.com/AI-for-dev/combo/issues/174)) ([3477278](https://github.com/AI-for-dev/combo/commit/3477278855a896cf7ed42d2b22ac20808d087a34))
* **flow:** let one taker through when two find the same stale lock ([#150](https://github.com/AI-for-dev/combo/issues/150)) ([fe7dfc5](https://github.com/AI-for-dev/combo/commit/fe7dfc5e9321fb21b619e93510ff2987c492543b))
* **flow:** name every branch of a parallel in a visit path ([#194](https://github.com/AI-for-dev/combo/issues/194)) ([fb5f83c](https://github.com/AI-for-dev/combo/commit/fb5f83c984c5ecbaa0d48767dc8538f082cf4700))
* **flow:** send a prose-only review back once, and end the turn on its verdict ([#172](https://github.com/AI-for-dev/combo/issues/172)) ([e51f683](https://github.com/AI-for-dev/combo/commit/e51f6833f215fb710d4e576db96e4e6f6320e92e))
* **flows:** leave a disagreement between reports to the synthesiser's own rule ([#178](https://github.com/AI-for-dev/combo/issues/178)) ([785a266](https://github.com/AI-for-dev/combo/commit/785a2661ccc2c7b2132b67725fa470c183b4ed15))
* **git:** run the commands on the list of copies one at a time per repository ([#176](https://github.com/AI-for-dev/combo/issues/176)) ([4314a83](https://github.com/AI-for-dev/combo/commit/4314a8379c988451849c7b9901099e0413e8ed96))
* **measure:** give every run a directory of its own ([#161](https://github.com/AI-for-dev/combo/issues/161)) ([295fcf3](https://github.com/AI-for-dev/combo/commit/295fcf3d1e9ea703e0b704e8a060aea468688716))
* **measure:** write main.jsonl when pi has not written the session file yet ([#162](https://github.com/AI-for-dev/combo/issues/162)) ([570d207](https://github.com/AI-for-dev/combo/commit/570d2075da210be51c54386a4671c1544c826c76))
* **pool:** honour an agent's frontmatter lifetime inside a workflow ([#185](https://github.com/AI-for-dev/combo/issues/185)) ([9264994](https://github.com/AI-for-dev/combo/commit/9264994a3ddd017c9a0212ddfc291c9938c79ff7))
* show only measured figures on the display, and keep every row inside the terminal ([#167](https://github.com/AI-for-dev/combo/issues/167)) ([e20b48b](https://github.com/AI-for-dev/combo/commit/e20b48b10e2f4fd552d131ec13d77cb23a4728c7))
* **skills:** say what was found when a declared skill is not ([#169](https://github.com/AI-for-dev/combo/issues/169)) ([dffdfb3](https://github.com/AI-for-dev/combo/commit/dffdfb3cc02be1fbbf073204da921a17f2c340fe))
* **subagent:** read a flow's deadline as a timeout in usage.json ([#180](https://github.com/AI-for-dev/combo/issues/180)) ([872aa54](https://github.com/AI-for-dev/combo/commit/872aa547611995cdf44e59485d69ef59c4f23755))
* **swarm:** give a member one cursor, so its read never repeats the handout ([#189](https://github.com/AI-for-dev/combo/issues/189)) ([9ffccab](https://github.com/AI-for-dev/combo/commit/9ffccab0fc73a9ce1c4c112bab12157f5aa26a8a))


### Documentation

* add a cheatsheet ([#182](https://github.com/AI-for-dev/combo/issues/182)) ([ee7d0e4](https://github.com/AI-for-dev/combo/commit/ee7d0e4b4d90f2c7c479fd8fe94017cb574024ab))
* align /step --from, the combinator count and the --model commands with the code ([#183](https://github.com/AI-for-dev/combo/issues/183)) ([1a349a5](https://github.com/AI-for-dev/combo/commit/1a349a588aa153021d6259ccc5f4fb3d762425b1))
* recapture /run explore in tutorials 02 and 10 after the retries ([#177](https://github.com/AI-for-dev/combo/issues/177)) ([7ddb915](https://github.com/AI-for-dev/combo/commit/7ddb915618fdbf777cfbeece253ff7f74c78ccf5))
* recapture the misspelt skill in tutorial 06 ([#173](https://github.com/AI-for-dev/combo/issues/173)) ([92c853f](https://github.com/AI-for-dev/combo/commit/92c853f2666d8a37e80805b58ba9431b84104788))
* recapture tutorials 01 to 06 after the display and verdict fixes ([#168](https://github.com/AI-for-dev/combo/issues/168)) ([32a58bd](https://github.com/AI-for-dev/combo/commit/32a58bdd44acf3ad641255a17aef7d580411b50c))
* recapture tutorials 02 to 07 on flows ([#165](https://github.com/AI-for-dev/combo/issues/165)) ([de39df8](https://github.com/AI-for-dev/combo/commit/de39df8174d3d3030a6d9b5a31c1308b63bac290))
* recapture tutorials 07 to 12 and the build, extension and experiments guides ([#170](https://github.com/AI-for-dev/combo/issues/170)) ([c6c53c8](https://github.com/AI-for-dev/combo/commit/c6c53c83e4ddf3c9286287865e01963a85f3d164))
* recapture tutorials 08 to 12 on flows ([#164](https://github.com/AI-for-dev/combo/issues/164)) ([5826bf3](https://github.com/AI-for-dev/combo/commit/5826bf3e93e26f4cd6fcb7ff87be1a9089b29336))
* say the plan in the flows guide is the opening example, not the shipped split ([#179](https://github.com/AI-for-dev/combo/issues/179)) ([0333e25](https://github.com/AI-for-dev/combo/commit/0333e2558ea13a8fd65eae43520b3bc56a40e93a))


### Code Refactoring

* **swarm:** move what a member is told into swarm-task.ts ([#195](https://github.com/AI-for-dev/combo/issues/195)) ([b86cdf7](https://github.com/AI-for-dev/combo/commit/b86cdf75350ab057f9faaeeb298331b3d3fa9c48))


### Tests

* stop the copies run once its branch has written, not on a clock ([#171](https://github.com/AI-for-dev/combo/issues/171)) ([7243079](https://github.com/AI-for-dev/combo/commit/724307924643cc7549a3f0805328c558c3696ef7))


### CI/CD

* stage the publish, and let a person finish it ([#133](https://github.com/AI-for-dev/combo/issues/133)) ([53c641b](https://github.com/AI-for-dev/combo/commit/53c641b6613170d943d1125224ef9932451528f4))

## [0.1.1](https://github.com/AI-for-dev/combo/compare/v0.1.0...v0.1.1) (2026-09-21)


### Bug Fixes

* follow pi 0.86, and clear the advisories that came with standing still ([#131](https://github.com/AI-for-dev/combo/issues/131)) ([ff0761a](https://github.com/AI-for-dev/combo/commit/ff0761aa63fe8d402621f038d9a2af10bf6082b0))


### CI/CD

* publish from its own workflow, with no npm token ([#130](https://github.com/AI-for-dev/combo/issues/130)) ([9a7f4c0](https://github.com/AI-for-dev/combo/commit/9a7f4c014bf4b1ccb28645504e01c16a306f632d))

## 0.1.0 (2026-09-21)


### Features

* publish the package on npm, and release it with Release Please ([#127](https://github.com/AI-for-dev/combo/issues/127)) ([13d6c0c](https://github.com/AI-for-dev/combo/commit/13d6c0c1db5451626641b1b05f7d4e2f4694d10b))


### CI/CD

* name the first release 0.1.0 rather than 1.0.0 ([#129](https://github.com/AI-for-dev/combo/issues/129)) ([3a720c8](https://github.com/AI-for-dev/combo/commit/3a720c8cccdbf5395f7b704fedf6426b3736faac))
