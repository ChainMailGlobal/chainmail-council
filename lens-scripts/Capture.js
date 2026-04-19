// Capture.js -- Sensor capture (ASR + Camera)
// ASR always on. Camera frame capture on demand.
// Sends raw data to Edge.js. Zero processing.

// @input Component.Camera spectaclesCamera {"label":"Spectacles Camera"}
// @input Asset.AsrModule asrModule {"label":"ASR Module"}

var AsrModule = require("LensStudio:AsrModule");

var asrRetryCount = 0;
var ASR_MAX_RETRIES = 3;
var asrRetryDelays = [2.0, 4.0, 8.0];
var asrRunning = false;

// ----------------------------------------------------------------
// Public API -- set by Edge.js
// ----------------------------------------------------------------

// Edge.js sets this callback: function(text, isFinal)
script.api.onVoiceCapture = null;

// ----------------------------------------------------------------
// ASR -- continuous transcription
// ----------------------------------------------------------------

function startAsr() {
    if (asrRunning) {
        return;
    }

    try {
        var options = AsrModule.AsrTranscriptionOptions.create();
        options.mode = AsrModule.AsrMode.Dictation;
        options.silenceUntilTerminationMs = 1500;

        options.onTranscriptionUpdateEvent.add(function(eventData) {
            onAsrTranscription(eventData);
        });

        options.onTranscriptionErrorEvent.add(function(errorCode) {
            onAsrError(errorCode);
        });

        script.asrModule.startTranscribing(options);
        asrRunning = true;
        asrRetryCount = 0;
        print("[Capture] ASR started");
    } catch (e) {
        print("[Capture] ASR start error: " + e);
        retryAsr();
    }
}

function stopAsr() {
    if (!asrRunning) {
        return;
    }
    try {
        script.asrModule.stopTranscribing();
        asrRunning = false;
        print("[Capture] ASR stopped");
    } catch (e) {
        print("[Capture] ASR stop error: " + e);
    }
}

function retryAsr() {
    if (asrRetryCount >= ASR_MAX_RETRIES) {
        print("[Capture] ASR max retries reached. Giving up.");
        return;
    }

    var delay = asrRetryDelays[asrRetryCount];
    asrRetryCount++;
    asrRunning = false;

    print("[Capture] ASR retry " + asrRetryCount + "/" + ASR_MAX_RETRIES + " in " + delay + "s");

    var retryEvent = script.createEvent("DelayedCallbackEvent");
    retryEvent.bind(function() {
        startAsr();
    });
    retryEvent.reset(delay);
}

// ----------------------------------------------------------------
// ASR event handlers
// ----------------------------------------------------------------

function onAsrTranscription(eventData) {
    if (!eventData) {
        return;
    }

    var text = eventData.transcription || "";
    var isFinal = eventData.isFinal || false;

    if (text.length === 0) {
        return;
    }

    if (script.api.onVoiceCapture) {
        script.api.onVoiceCapture(text, isFinal);
    }
}

function onAsrError(errorCode) {
    print("[Capture] ASR error: " + errorCode);
    asrRunning = false;
    retryAsr();
}

// ----------------------------------------------------------------
// Camera -- frame capture
// ----------------------------------------------------------------

script.api.captureFrame = function() {
    if (!script.spectaclesCamera) {
        print("[Capture] WARNING: No camera reference. Returning placeholder.");
        return "PLACEHOLDER_NO_CAMERA";
    }

    try {
        var renderTarget = script.spectaclesCamera.renderTarget;
        if (!renderTarget) {
            print("[Capture] WARNING: No render target on camera.");
            return "PLACEHOLDER_NO_RENDER_TARGET";
        }

        var texture = renderTarget.copyFrame();
        if (!texture) {
            print("[Capture] WARNING: copyFrame() returned null.");
            return "PLACEHOLDER_NO_FRAME";
        }

        if (texture.encodeToBase64 && typeof texture.encodeToBase64 === "function") {
            return texture.encodeToBase64();
        }

        if (texture.control && texture.control.getPixels) {
            var pixels = texture.control.getPixels(0, 0, texture.getWidth(), texture.getHeight());
            if (pixels) {
                print("[Capture] WARNING: Got raw pixels but no base64 encoder. Sending placeholder.");
                return "PLACEHOLDER_RAW_PIXELS_AVAILABLE";
            }
        }

        print("[Capture] WARNING: No base64 encoding available on this platform. Sending placeholder.");
        return "PLACEHOLDER_ENCODING_UNAVAILABLE";

    } catch (e) {
        print("[Capture] Frame capture error: " + e);
        return "PLACEHOLDER_CAPTURE_ERROR";
    }
};

// ----------------------------------------------------------------
// Expose ASR controls
// ----------------------------------------------------------------

script.api.startAsr = startAsr;
script.api.stopAsr = stopAsr;
script.api.isAsrRunning = function() {
    return asrRunning;
};

// ----------------------------------------------------------------
// Init
// ----------------------------------------------------------------

script.createEvent("OnStartEvent").bind(function() {
    print("[Capture] Initializing...");
    print("[Capture] Camera: " + (script.spectaclesCamera ? "wired" : "NOT WIRED"));
    print("[Capture] ASR Module: " + (script.asrModule ? "wired" : "NOT WIRED"));

    startAsr();
});
