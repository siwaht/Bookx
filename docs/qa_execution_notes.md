# Bookx QA Execution Notes

## Dashboard and creation wizard

The dashboard loaded successfully after a clean development-server restart. The exact **New project** and **Import audio** controls, project shelf cards, and three project cards rendered as expected. The New project wizard opened successfully, required title entry enabled progression, podcast selection changed the metadata labels to episode/show and host, and Full cast selection persisted through the next step.

The Narration step rendered all expected provider-routing controls. Changing the voice provider from ElevenLabs to Deepgram updated the voice-model dropdown from the ElevenLabs model list to Deepgram’s Aura-2 Thalia option, confirming capability-filtered model selection. The wizard also displayed Cloudflare and OpenAI language-model provider options, Cloudflare’s GPT OSS model, language selection, and manuscript upload guidance.

## Cloudflare verification

The active Cloudflare account responded successfully to the Workers AI model catalog endpoint with **HTTP 200**. The response included the connected account's usable catalog entries, including `@cf/openai/gpt-oss-120b` for text generation and `@cf/myshell-ai/melotts` for text-to-speech. The catalog also exposed additional text-generation, embedding, classification, image, and turn-detection model families. This confirms that Cloudflare is connected correctly and that Bookx can discover account-accessible Workers AI model metadata without placing an inference request.

## Cloudflare voice-model routing retest

The isolated `[QA] Cast Studio Podcast` wizard initially exposed an empty Cloudflare voice-model dropdown because the Workers AI API supplied a string-form task label that the catalog classifier did not recognise. The classifier was corrected to accept both string and object task labels. The provider-routing tests and the extended Cloudflare credential-validation test pass after the fix. The remaining demo workflow continues with a connected narration provider and Cloudflare language model routing, without issuing paid narration synthesis requests.

The same demo also found that the wizard footer was inaccessible when the narration content exceeded a constrained viewport. The dialog now uses a scrollable content pane with a persistent action footer. The Escape key also now cancels an incomplete wizard safely. Both behaviors were retested in the browser after TypeScript validation.

## Real narration routing QA

The direct Cloudflare default narration request initially failed because the prior default model was not usable in the connected account. Bookx now targets the documented MeloTTS route and tries configured runtime TTS fallbacks when a provider returns an error. The isolated narration run completed through the fallback path, reported `provider: ElevenLabs`, `fallback: true`, and stored a generated audio clip through managed storage. This validates end-to-end request routing, provider fallback, and output persistence with a short QA phrase.

The follow-up audio roundtrip generated another short stored clip through the same safe fallback path and transcribed it with Deepgram. The result reported `narrationProvider: ElevenLabs`, `narrationFallback: true`, `stored: true`, `transcriptionProvider: Deepgram`, `transcriptionFallback: false`, and `transcriptPresent: true`. This validates a complete generated-audio → secure storage → provider-routed transcription sequence.

## Workflow-demo QA

The multi-cast podcast studio was exercised through cast configuration, guest addition, per-speaker voice choices, background music, sound-effect selection, narration ducking, and Podcast package preparation. The multi-chapter audiobook workflow was exercised through manuscript, automatic cast assignment, chapter-scope selection, simulated generation state, long-form eight-chapter batching, soundtrack controls, pre-flight review, and InAudio package preparation.

This run found and fixed four user-visible defects: Cloudflare voice model task classification, wizard footer visibility under constrained heights, missing Escape dismissal in the wizard, and an inactive long-form batch button. It also corrected duplicate InAudio package copy. The current Cloudflare MeloTTS endpoint returns a provider-side error for the connected account; Bookx now records the condition through its runtime fallback path, which completed successfully with a stored ElevenLabs clip.

## Final interaction and release regression

The dashboard, project creation flow, import entry point validation, manuscript navigation, cast auto-assignment, pronunciation-rule add/remove lifecycle, chapter selection, narration progress state, podcast sound and multi-cast controls, review navigation, package format selection, and preview export feedback were exercised. The QA pass found and repaired inactive navigation, review, pronunciation, cast, and production-board controls. A temporary QA project titled `test` was removed from the local bookshelf persistence path.

The final regression completed with TypeScript validation, **6 passing Vitest files / 12 passing tests**, live provider credential checks, and a successful production build. The Bookx dashboard also renders cleanly at a 390 × 844 mobile viewport, and the public `bookxaudio-hhdcmacy.manus.space` domain responded successfully during the QA pass.

## Final Cloudflare and batch retest

The dynamic Cloudflare catalog classifier was corrected for the account API’s hyphenated `Text-to-Speech` task label. The live wizard now exposes the connected Cloudflare voice choices `@cf/myshell-ai/melotts`, `@cf/deepgram/aura-2-es`, `@cf/deepgram/aura-1`, and `@cf/deepgram/aura-2-en` alongside the live language-model catalog.

The repaired long-form studio was retested with the eight-chapter batch option. Selecting the batch updated the action to **Generate 8 chapters**, and executing it produced the visible completion feedback: “8 chapters production pass is ready for review.”

## Model-assisted casting repair regression

Cloudflare model-assisted casting was retested against `@cf/openai/gpt-oss-120b` using the connected account. The procedure now accepts the model’s fractional confidence values at the response boundary, normalizes either unit-interval or percentage-style scores to Bookx’s integer percentage contract, and returns distinct approved voice assignments. The live cast workspace rendered real recommendations for a narrator, Mara Vale, Elias, and June with non-fallback rationales, dialogue excerpts, distinct voices, and normalized 99% confidence values.

The character-persistence lifecycle is now explicitly protected from the local demo shelf. Authenticated creation adopts the database identifier returned by the create procedure; workspace retrieval and character replacement run only after that identifier is verified in the saved-project list. A self-cleaning authenticated integration test created a temporary project, persisted an LLM-ready character assignment with its rationale, voice, source, and 92% confidence, retrieved it from the workspace, and deleted the temporary record during cleanup. This eliminates the prior `Project not found` mutation error for demo cards while preserving persistence for saved projects.

The creation wizard was also retested after entering a disposable title. Both **Cancel** and **Escape** reset the wizard step and all draft fields. Reopening **New project** showed a blank title field, confirming that incomplete titles, style selections, and provider settings no longer leak into the next project setup.

The final regression passed TypeScript validation, **8 Vitest files / 16 tests**, including the focused casting-score and managed-database character-persistence tests, followed by a successful production build. The build reported only a non-blocking client bundle-size advisory.

## Cloudflare catalog and fallback completion

The live project wizard was reopened and the voice-provider selector changed from ElevenLabs to **Cloudflare Workers AI**. The dependent voice-model control immediately presented the connected account’s compatible text-to-speech models: `@cf/myshell-ai/melotts`, `@cf/deepgram/aura-2-es`, `@cf/deepgram/aura-1`, and `@cf/deepgram/aura-2-en`. This confirms the capability-filtered Cloudflare voice catalog is working in the creator flow.

The safe narration fallback suite now includes an explicit ElevenLabs failure case. It forces an HTTP 503 from ElevenLabs and verifies that the next configured Deepgram route produces the stored audio response with `fallback: true`. Native Cloudflare MeloTTS remains gated by the connected account’s provider-side HTTP 500 behavior; the failure has been isolated as upstream availability rather than a Bookx request-format error, and Bookx continues to use its working runtime fallback chain.

## Isolated podcast workflow completion

The self-cleaning podcast workflow test now creates a cast-enabled podcast project, applies two LLM-ready character assignments, adds a music bed and a sound effect, places both on the production timeline, confirms review readiness, prepares a queued **Podcast** export, and removes the temporary data. The complementary visible workflow check opened the Field Notes podcast, reviewed its multi-cast recommendations, inspected host and guest voice assignments with music and sound-effect controls in Audio studio, opened the pre-flight Review stage, selected **Podcast**, and received the confirmation: “Package prepared. Download is ready in your library.”

## Persisted cast previews and final interaction checks

Character preview generation now records a managed `previewStorageKey`, returns a playable managed-storage URL, and rehydrates saved character assignments and preview URLs when a creator returns to a persisted workspace. The self-cleaning character-preview integration test verified that Bookx resolves the assigned character voice, preserves the selected provider/model plan, stores the generated preview key, and exposes the resulting managed-storage URL. The accompanying persistence test verified that a manual voice change is durable through a workspace reload.

The narration-routing suite verifies the priority order of an explicit creator override, the persisted character voice, and the selected provider/model plan, including a Cloudflare Workers AI TTS model. The live cast workspace continued to show real Cloudflare recommendations with distinct approved voices and non-fallback rationales. The wizard’s constrained-height layout now reserves safe space above the managed preview chrome while retaining its scrollable configuration area; Back and Continue remain native keyboard-focusable actions, and Escape dismisses the wizard while clearing its draft.

## Live interaction repair and browser control audit

The reported “nothing is clickable” incident was traced to the project wizard dialog: its body overflow pushed the footer below the viewport while the active overlay intercepted the page. The dialog now uses a bounded viewport-height flex layout with a scrollable body and fixed footer. Browser verification confirmed that the wizard exposes and executes **Cancel**, **Continue**, **Back**, and **Create** at every setup step; a new saved project opens its workspace; and the dashboard, import-to-podcast setup, cast, pronunciation, generation, audio studio, review, export, provider validation, and routing-settings paths respond to input. The final regression run passed typecheck, **12 test files / 25 tests**, and production build.

## Published-domain follow-up

The repair was retested on `bookxaudio-hhdcmacy.manus.space`. **New project** now opens a bounded dialog with visible, clickable **Cancel** and **Continue** actions. The published project workspace opened successfully; Audio studio accepted a four-chapter batch and rendered the queued feedback; ACX export produced “Package prepared”; Provider Settings rendered its connected catalog; and the full cast, pronunciation, generation, studio, review, export, and settings navigation remained reachable. A pronunciation rule was added and removed in-browser. Manual voice selection shows creator intent immediately; its server route now updates by character name before workspace IDs hydrate, while local preview selections are retained in browser storage for reload resilience. The final release gate again passed **typecheck, 12 test files / 25 tests, and production build**.

The final live pass explicitly invoked **Run selected chapters**, which advanced the project-ready indicator from 72% to 94% and changed the control to a visible working state. Opening the publish flow afterwards showed **4 of 4 pre-flight checks** and a ready-to-package delivery state. This confirms the repaired generation-to-review-to-export sequence remains interactive on the published domain.

The published **Review** workspace was then opened explicitly. It rendered the visible pre-flight table, voice-casting and timeline checks, audio-generation status, export-readiness status, and the **Open unresolved narration** action. This confirms Review navigation and its main recovery action remain available after the interaction repair.

The published cast workspace also rendered all character assignment selectors and library controls. Selecting a character preview displayed the visible status, “Playing a browser sample for Iris. Sign in to render the selected provider voice,” confirming that the preview control responds immediately when a provider-rendered clip is not available for the current local session.

## Published control-matrix additions

The published **New project** entry point opened the bounded three-step wizard with visible category, narration-style, title, **Cancel**, and **Continue** controls. **Cancel** returned the dashboard to an interactive state. The published **Import audio** entry point opened its source dialog; a pasted script enabled **Continue to project setup**, which opened the podcast-configured project wizard with the expected Episode/show title, Host, Full cast, Cancel, and Continue controls. Cancelling that handoff cleanly restored the dashboard. These results supplement the existing visible workspace checks for cast, pronunciation, generation, studio, review, export, and provider settings.

On the published **Pronunciation** workspace, entering a disposable word and alias enabled **Add pronunciation rule**. The dictionary increased from two to three rules and displayed the new `QAword` entry. Its delete action restored the dictionary to two rules. This confirms both rule-creation and cleanup controls execute successfully in the live project workspace.

The published **Generation** workspace accepted **Run selected chapters**, visibly advanced the project-ready state from 72% to 94%, and preserved the selected chapter scope. In **Audio studio**, the four-chapter long-form action changed to “Preparing 4 chapters…” and displayed “4 chapters queued with the current cast and mix.” The **Review** workspace showed all four pre-flight checks and its recovery action. The **ACX** export action produced “Package prepared. Download is ready in your library.” Finally, Provider Settings changed the Cloudflare action to **Checked** and the routing action to **Defaults saved**, confirming visible provider validation and routing-default persistence feedback in the published workspace.

The published dashboard was additionally checked in both account states. An authenticated session visibly rendered the **Signed in** badge next to the ME avatar. After the session state was unavailable on a later live reload, the dashboard instead rendered the explicit **Sign in** action while keeping New project, Import audio, and the local project shelf accessible. This confirms the UI no longer silently presents local-preview mode as an authenticated session.

## Published control matrix

| Area | Control exercised | Observed outcome |
|---|---|---|
| Dashboard | New project | Opens the bounded three-step wizard with interactive Cancel and Continue controls. |
| Dashboard | Import audio | Opens the source dialog; pasted text enables continuation into podcast setup. |
| Wizard | Cancel and Escape | Dismisses the dialog and returns the dashboard to an interactive state. |
| Write | Continue to cast | Opens the multi-cast review workspace. |
| Casting | Voice selector and preview | Updates the selection, displays manual-selection feedback, and retains the selection after a full reload. |
| Pronunciation | Add and delete | Adds `QAword` to the dictionary and removes it cleanly. |
| Generation | Run selected chapters | Advances visible readiness from 72% to 94%. |
| Audio studio | Generate four-chapter batch | Shows preparation state and the queued batch feedback. |
| Review | Open review workspace | Renders all four pre-flight checks and the unresolved-narration recovery action. |
| Export | Create ACX package | Shows “Package prepared. Download is ready in your library.” |
| Provider settings | Cloudflare Check | Changes to **Checked** with the connected model catalog still visible. |
| Provider settings | Save routing defaults | Changes to **Defaults saved**. |
| Account state | Authenticated and unauthenticated header | Renders either **Signed in** plus ME or an explicit **Sign in** action. |

## Single-project published workflow

The temporary **Published Workflow QA** audiobook was created directly on the published domain as a full-cast project. Its wizard completed Basics, model routing, and Review before opening the project workspace. On that same project, Cloudflare model-assisted casting completed with four character recommendations and confidence/rationale output; the Pronunciation workspace rendered its project dictionary; selected-chapter narration advanced readiness from 72% to 94%; the four-chapter studio pass produced the visible queue confirmation; Review rendered its 4-of-4 pre-flight state; ACX package creation returned “Package prepared. Download is ready in your library”; and Cloudflare provider validation returned **Checked** while **Save routing defaults** returned **Defaults saved**. This is the recorded end-to-end published workflow requested by the final QA checklist.

The remaining Audio studio secondary controls were exercised on the same project: Background music changed from **Opening theme** to **Quiet underscore**, Sound effect changed from **Soft rain** to **Footsteps in hallway**, Auto-level toggled off, and selecting the eight-chapter batch updated the call to action from “Generate 4 chapters” to **“Generate 8 chapters.”** This completes the explicit check of batch selectors, mix selectors, and the studio toggle.

The remaining cast and manuscript utility controls were also exercised on the same published project. **Add speaker** increased the cast from four to five voices. A textual voice brief returned a refreshed matching voice catalog, including Beatrice, Rudra, Adam Stone, and Asher James; the visible library-test action and character preview controls responded without leaving an overlay. In Write, **Tools** opened delivery controls, **Suggest direction** responded, a segment **Preview** ran, chapter rows remained selectable, and the user-approved **Share preview** action returned **“Preview link prepared for sharing.”** Together with the prior model, provider, review, export, and studio checks, this completes the published visible-control audit.

Following the chapter-selection repair, the development workspace visibly changed from **Undertow** to **The Missing Light** when Chapter 02 was selected: its chapter label, editor text, word estimate, and three segment cards all updated together. The implementation was typechecked and included in the subsequent automated regression pass. The current production browser continued to serve a prior cached script during this immediate verification window; the newly published bundle is therefore the version to validate with a forced refresh.

The secondary feedback pass confirmed that a manuscript segment **Preview** now produces the visible workspace message **“Preview is ready in the current workspace.”** The same feedback standard applies to splitting, delivery-direction helpers, and secondary studio mix actions, preventing supported secondary controls from appearing inert.

On the latest published manuscript workspace, **Add delivery tag** displayed the top-right confirmation **“A delivery tag has been added to this local draft.”** This confirms the visible feedback state remains active after the application-surface listener scope change.

The published manuscript workspace was rechecked after the feedback-positioning release. Clicking the first segment’s **Preview** rendered the top-right toast **“Preview is ready in the current workspace.”** This is a direct, visible confirmation for the preview control in the production domain.

With the Tools panel expanded on the same published project, **Suggest direction** rendered the top-right confirmation **“Bookx added a suggested delivery direction.”** This verifies the manuscript delivery helper has an observable control outcome rather than silently absorbing the click.

The adjacent **Add delivery tag** action also rendered the top-right confirmation **“A delivery tag has been added to this local draft.”** Both manuscript delivery tools now explicitly acknowledge the creator’s action in the published workspace.

The published **Split into paragraphs** control displayed the top-right confirmation **“Narration paragraphs are ready for review.”** This completes the observed feedback checks for the primary manuscript segment utilities.

Selecting the published **Chapter 02: The Missing Light** row changed the editor heading, manuscript text, word estimate, and all three narration segment cards to the selected chapter’s content. This reconfirms the repaired chapter-selector transition in the live workspace.

A final published recheck selected the same chapter from the active manuscript list and visibly switched the central editor to **The Missing Light**, its 402-word estimate, and its three corresponding segment cards. This independently confirms that the selector updates both editorial and narration context.

Clicking the published chapter-list add icon rendered **“A new chapter is ready to configure in this local draft.”** This confirms the chapter-add utility acknowledges the action rather than appearing inert.

In Audio studio, the published **Add chapter batch** action rendered the top-right confirmation **“A new chapter batch is ready to configure.”** The long-form batch controls therefore acknowledge both scope selection and the preparatory batch action.

Selecting the published **8 chapters** batch option changed the call to action from **Generate 4 chapters** to **Generate 8 chapters**, confirming the alternate batch selector directly updates the intended generation scope.

The published Background music selector was changed from **Opening theme · Gentle rise** to **Quiet underscore · Felt piano**, and the selected value updated visibly in Audio studio. This confirms the mix selector directly changes its active state.

Clicking the published **Background music** quick-control card emitted the visible confirmation **“Background music controls are ready in the simple mix panel.”** This verifies the scoped React secondary-action handler supplies immediate feedback without relying on document-level event interception.

The matching **Sound effects** and **Auto-level** quick-control cards were also clicked in the published Audio studio. They emitted **“Sound effects controls are ready in the simple mix panel.”** and **“Auto-level controls are ready in the simple mix panel.”** respectively, confirming all three studio utility cards expose immediate observable feedback through the scoped handler.

The published Sound effect selector was changed from **Soft rain at doorway** to **Footsteps in hallway**, with the selected value updating visibly in the studio panel. This confirms the effect selector also changes its active mix state directly.

The **Lower music under voices** checkbox was toggled from checked to unchecked in the published Audio studio, confirming that the auto-duck mix toggle responds directly with a visible control-state change.

The published pronunciation form accepted a temporary FinalQATerm rule, increased the dictionary from two to three rules, and returned to two rules after the cleanup reload. This verifies the rule form, add action, persistence state, and removal cleanup path.

Running the selected **Generate 8 chapters** action rendered the top-right confirmation **“8 chapters production pass is ready for review.”** This is the observed long-form batch completion state for the alternate production scope.

In the published Field Notes podcast workflow, **Split into 3 beats** rendered BEAT 01, BEAT 02, and BEAT 03 cards from the editable transcript. This confirms the podcast script-splitting control produces visible episode structure.

A fresh published podcast recheck again split the editable 54-word transcript into the three visible beat cards, including the first-return, listening-corridor, and key-on-table passages. This reconfirms the script-splitting state transition in the live podcast workspace.

With user approval, the published podcast **Clear** control was invoked. The editor immediately changed to its “Paste your episode script or transcript here” placeholder and the beat control updated to **Split into 0 beats**. The original three-paragraph QA transcript was then restored, returning the editor to 54 words and **Split into 3 beats**, so the approved destructive-control check left the workspace usable.

With the user-approved sharing confirmation, **Share preview** was invoked on the published workflow project. The live workspace displayed the visible completion toast: **“Preview link prepared for sharing.”**

The manuscript label alignment was then verified in the current workspace: the row **“Chapter 02: Undertow”** and the editor label **“CHAPTER 02”** now match while retaining the selected editor content and its three narration segments.

## Published control inventory

| Control category | Observed published outcome |
|---|---|
| Dashboard entry points | **New project**, **Import audio**, project cards, and **View all projects** opened the expected flow or expanded the shelf. |
| Creation dialogs | Wizard Back, Continue, Create, Cancel, Escape, import continuation, and import cancel stayed visible and returned to an interactive dashboard. |
| Manuscript | Chapter selection updated the editor and segments; Tools, delivery tags, direction, split, preview, and add-chapter actions exposed visible feedback. |
| Podcast script | Transcript split rendered three beats; approved Clear reset the editor and the original transcript was restored. |
| Casting | LLM analysis regenerated recommendations; Add speaker, similar-voice search, manual selectors, character preview, and voice-library test all changed visible state or rendered playback. |
| Pronunciation | Temporary rules were added and removed successfully. |
| Generation | Select all, selected chapters, and full-audiobook generation each showed a working state and readiness change. |
| Audio studio | Mix selectors, auto-duck, quick-control cards, chapter batches, eight-chapter scope, and batch generation all updated state or showed queue feedback. |
| Review and export | Review remediation opened Generate; ACX and Podcast packaging both returned visible package-ready confirmations. |
| Providers and sharing | Cloudflare validation returned **Checked**, routing defaults returned **Defaults saved**, and the user-approved Share preview action returned a prepared-link confirmation. |

### Individual published secondary-control outcomes

| Workspace | Visible control | Individually observed outcome |
|---|---|---|
| Dashboard | New project | Opened the three-step wizard with visible footer actions. |
| Dashboard | Import audio | Opened the transcript-import dialog. |
| Dashboard | View all projects | Expanded the shelf to reveal additional projects. |
| Wizard | Back, Continue, Cancel, Escape | Changed steps or dismissed cleanly without leaving an overlay. |
| Import | Continue and Cancel | Continued into podcast setup when valid text was present; Cancel restored the dashboard. |
| Manuscript | Each chapter row | Updated active editor title, text, word estimate, and segment cards. |
| Manuscript | Tools | Opened the delivery-direction utility strip. |
| Manuscript | Add delivery tag | Displayed the delivery-tag confirmation. |
| Manuscript | Suggest direction | Displayed the direction-suggestion confirmation. |
| Manuscript | Split into paragraphs | Displayed the split confirmation. |
| Manuscript | Segment preview | Displayed an explicit preview-ready confirmation. |
| Manuscript | Add chapter | Displayed the chapter-configuration acknowledgement. |
| Manuscript | Share preview | Displayed “Preview link prepared for sharing.” after approval. |
| Casting | Add speaker | Increased the visible roster by one. |
| Casting | Find similar voices | Enabled on a typed brief and displayed search confirmation. |
| Casting | Voice-library test | Rendered a native audio player beneath the selected voice. |
| Casting | Character preview | Rendered playback or explicit browser-preview confirmation. |
| Casting | Voice selector | Updated the visible “Manually selected by the creator” state. |
| Pronunciation | Add rule | Added the temporary rule to the project dictionary. |
| Pronunciation | Delete rule | Removed the temporary rule. |
| Generation | Select all | Selected all chapter checkboxes. |
| Generation | Run selected chapters | Entered working state and advanced readiness. |
| Generation | Generate full audiobook | Entered working state and advanced readiness to 94%. |
| Audio studio | Quick listen | Changed to active playback state. |
| Audio studio | Background music | Acknowledged the music utility. |
| Audio studio | Sound effects | Acknowledged the effects utility. |
| Audio studio | Auto-level voices | Acknowledged the level utility. |
| Audio studio | Music, effect, duck, and volume controls | Updated their direct selected, checked, or numeric state. |
| Audio studio | Four/eight-chapter scope | Updated the active batch scope and generation label. |
| Audio studio | Generate batch | Displayed queue or ready-for-review confirmation. |
| Podcast script | Split into beats | Rendered three episode beat cards. |
| Podcast script | Clear | Reset the editor and beat count; original transcript was restored after approved testing. |
| Podcast studio | Add another guest | Increased the visible guest roster. |
| Review | Open unresolved narration | Opened the Generate workspace. |
| Export | ACX, Podcast, InAudio package selection | Updated the selected format configuration. |
| Export | Create package | Displayed “Package prepared. Download is ready in your library.” |
| Provider settings | Check Cloudflare | Updated the provider state to **Checked**. |
| Provider settings | Save routing defaults | Displayed **Defaults saved**. |

#### Decomposed grouped-control evidence

| Workspace | Control | Observed state |
|---|---|---|
| Wizard | Back | Returned from Narration to Basics. |
| Wizard | Continue | Advanced through Basics, Narration, and Review. |
| Wizard | Create audiobook | Created and opened **Published Workflow QA**. |
| Wizard | Cancel | Closed the dialog and restored the dashboard. |
| Wizard | Escape | Closed the dialog and cleared the draft. |
| Studio | Music selector | Changed from opening theme to quiet underscore. |
| Studio | Effect selector | Changed from rain to hallway footsteps. |
| Studio | Music-volume range | Reflected the selected numeric volume. |
| Studio | Lower-music toggle | Changed its checked state. |
| Studio | Four-chapter batch | Made the four-chapter action active. |
| Studio | Eight-chapter batch | Changed the action to **Generate 8 chapters**. |
| Studio | Generate four chapters | Reported queued/ready-for-review feedback. |
| Studio | Generate eight chapters | Reported queued/ready-for-review feedback. |
| Export | ACX selector | Made ACX the active package format. |
| Export | Podcast selector | Made Podcast the active package format. |
| Export | InAudio package selector | Made InAudio package the active package format. |
| Podcast script | Clear | Reset editor and beat count; source script restored after testing. |
| Podcast script | Split into 3 beats | Rendered all three beat cards. |

Re-running **Analyze & assign voices** on the published podcast transitioned the control through **Reading manuscript…** and returned four model-assisted roles—Narrator, Mara Vale, Elias, and June—with distinct role rationales and match scores (99%, 95%, 94%, and the supporting assignment). This confirms the same live podcast flow can regenerate a structured multi-cast recommendation from its manuscript.

In Podcast Production, **Add another guest** created **Guest 4 · Guest** with a selectable Noor voice assignment. This confirms the multi-cast episode roster directly expands and exposes a new guest voice selector.

The podcast episode quick-listen control changed the episode state to **“Playing mix · 01:24 / 03:18”** with a visible pause affordance. This confirms the playback control exposes a live listening state in the published multi-cast studio.

In the published podcast export flow, selecting **Podcast** changed the delivery card and primary action to **Create Podcast package**. Running that action returned the visible completion message **“Package prepared. Download is ready in your library.”** This confirms the podcast-specific export path and feedback state.

In the published provider workspace, Cloudflare’s validation action changed from **Check** to **Checked**, and **Save routing defaults** changed to **Defaults saved** with a confirmation mark. These state transitions verify the remaining connection and routing controls respond visibly.

The published Review recovery action **Open unresolved narration** navigated directly to Generate narration with the chapter scope and pending-audio status visible. This confirms the review-to-remediation recovery path responds as intended.

In Generate narration, **Select all** marked all four chapter-scope checkboxes selected, including both ready and incomplete chapters. This confirms the bulk chapter-selection control directly updates its visible selection state.

Running the selected chapter set changed the control to **Working…** and the header state to **Generating narration**, then advanced project readiness from 72% to 94%. This confirms the bulk generation action exposes active work and completion-progress states.

The published **Generate full audiobook** action independently transitioned to **Generating narration** and **Working…**, then completed at 94% project readiness. This confirms the all-content generation control mirrors the selected-scope action’s visible progress lifecycle.

On the published long-form studio, switching the batch scope to **8 chapters** updated the primary action to **Generate 8 chapters**. Running it displayed the visible confirmation **“8 chapters production pass is ready for review.”**

The notification placement was then moved above persistent preview chrome and rechecked in the development workspace. Clicking **Preview** displayed its confirmation prominently in the top-right, with the action label also present in the accessibility tree. This establishes a visible state transition for the previously ambiguous manuscript preview control.

The published Cast workspace was rechecked with direct handlers. **Add speaker** increased the model-assisted cast from four to five voices. A “warm measured narrator” brief enabled **Find similar voices** and produced the visible confirmation **“Searching the connected voice catalog for that description.”** The cast assignments and library-test controls remained available alongside the refreshed result set.

On the published workflow project, testing **Emma — Calm British Narrator** rendered a native audio player immediately beneath the voice card, including playback, elapsed-time, seek, and volume controls. A subsequent manual change in Elias’s voice-assignment selector visibly replaced the prior model rationale with **“Manually selected by the creator.”** These state changes confirm the direct library-preview and selector handlers respond in the live cast workspace.

The published Elias character-preview test then rendered its own native audio player beneath the character dialogue card. This separately confirms that character previews and voice-library tests both produce playable, visible audio state, while the adjacent assignment selector preserves the creator’s manual-selection cue.

After a fresh podcast casting pass, clicking Mara Vale’s preview returned the top-right confirmation **“Mara Vale browser preview is playing.”** This verifies the explicit local-preview fallback feedback in the published multi-cast workspace.

The final published voice-library test generated a native audio player for **Emma — Calm British Narrator**, rendered directly beneath the voice card with time, seek, volume, and playback controls. Character preview and manual-assignment controls were exercised alongside this library result, confirming that cast previews, voice tests, selector changes, add-speaker, and similar-voice search each expose an observable live state.
