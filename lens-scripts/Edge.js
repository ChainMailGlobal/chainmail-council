// Edge.js -- Entry point and event coordinator
// Coordinates Capture.js and Display.js. Sends all events to backend.
// Zero intelligence on device. Capture + send + display.

// @input Component.ScriptComponent capture {"label":"Capture Script"}
// @input Component.ScriptComponent display {"label":"Display Script"}
// @input string authToken = "" {"label":"Supabase JWT"}
// @input string gatewayUrl = "https://emyiiapbjrijawaejcxd.supabase.co/functions/v1/spectacles-gateway" {"label":"Gateway URL"}

var recording = false;
var responseMode = "audio";
var sessionId = "chainmail_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
var frameTimer = 0;
var FRAME_INTERVAL = 3.0;
var REQUEST_TIMEOUT_MS = 30000;

// ----------------------------------------------------------------
// HTTP -- POST to gateway
// ----------------------------------------------------------------

function postToGateway(eventType, payload, mode, onResponse) {
    var request = RemoteServiceHttpRequest.create();
    request.url = script.gatewayUrl;
    request.method = RemoteServiceHttpRequest.HttpRequestMethod.Post;
    request.setHeader("Content-Type", "application/json");
    request.setHeader("Authorization", "Bearer " + script.authToken);

    var body = {
        type: eventType,
        session_id: sessionId,
        payload: payload,
        mode: mode,
        response_mode: responseMode,
        ts: Date.now()
    };

    request.body = JSON.stringify(body);

    var timedOut = false;
    var responded = false;

    // Timeout via delayed callback
    var timeoutEvent = script.createEvent("DelayedCallbackEvent");
    timeoutEvent.bind(function() {
        if (!responded) {
            timedOut = true;
            print("[Edge] Request timed out: " + eventType);
        }
    });
    timeoutEvent.reset(REQUEST_TIMEOUT_MS / 1000);

    request.perform(function(response) {
        responded = true;
        if (timedOut) {
            return;
        }
        try {
            var status = response.statusCode;
            if (status >= 200 && status < 300) {
                var data = JSON.parse(response.body);
                if (onResponse) {
                    onResponse(data);
                }
            } else {
                print("[Edge] HTTP " + status + " for " + eventType + ": " + response.body);
            }
        } catch (e) {
            print("[Edge] Parse error for " + eventType + ": " + e);
        }
    });
}

// ----------------------------------------------------------------
// Response handler -- route backend response to Display.js
// ----------------------------------------------------------------

function handleResponse(data) {
    if (!data) {
        return;
    }

    // Recording indicator
    if (data.recording !== undefined && script.display && script.display.api) {
        script.display.api.showRecording(data.recording);
    }

    // Text response
    if (data.text && script.display && script.display.api) {
        var agentName = data.agent || "";
        script.display.api.showText(agentName, data.text);
    }

    // Audio response
    if (data.audio && script.display && script.display.api) {
        script.display.api.playAudio(data.audio);
    }

    // Mode switch from backend
    if (data.response_mode) {
        responseMode = data.response_mode;
        print("[Edge] Response mode set to: " + responseMode);
    }
}

// ----------------------------------------------------------------
// Voice transcription callback (set on Capture.js)
// ----------------------------------------------------------------

function onVoiceTranscription(text, isFinal) {
    if (!text || text.length === 0) {
        return;
    }

    var payload = {
        text: text,
        is_final: isFinal
    };

    var mode = recording ? "record" : "passive";

    postToGateway("voice", payload, mode, handleResponse);
}

// ----------------------------------------------------------------
// Frame capture -- called on interval when recording
// ----------------------------------------------------------------

function captureAndSendFrame() {
    if (!script.capture || !script.capture.api || !script.capture.api.captureFrame) {
        return;
    }

    var frameData = script.capture.api.captureFrame();
    if (!frameData) {
        return;
    }

    var payload = {
        image_base64: frameData
    };

    postToGateway("frame", payload, "record", function(data) {
        // Frames typically don't produce display updates, but handle if they do
        if (data && (data.text || data.audio)) {
            handleResponse(data);
        }
    });
}

// ----------------------------------------------------------------
// Button toggle -- record mode
// ----------------------------------------------------------------

function toggleRecording() {
    recording = !recording;
    frameTimer = 0;

    print("[Edge] Recording: " + (recording ? "ON" : "OFF"));

    // Notify display immediately
    if (script.display && script.display.api) {
        script.display.api.showRecording(recording);
    }

    var payload = {
        button: "left",
        action: "press",
        recording: recording
    };

    var mode = recording ? "record" : "passive";

    postToGateway("button", payload, mode, handleResponse);
}

// ----------------------------------------------------------------
// Expose API for external trigger
// ----------------------------------------------------------------

script.api.toggleRecording = toggleRecording;
script.api.isRecording = function() {
    return recording;
};

// ----------------------------------------------------------------
// Init
// ----------------------------------------------------------------

script.createEvent("OnStartEvent").bind(function() {
    print("[Edge] Session: " + sessionId);
    print("[Edge] Gateway: " + script.gatewayUrl);
    print("[Edge] Auth token length: " + (script.authToken ? script.authToken.length : 0));

    // Wire voice callback to Capture.js
    if (script.capture && script.capture.api) {
        script.capture.api.onVoiceCapture = onVoiceTranscription;
        print("[Edge] Voice callback wired to Capture.js");
    } else {
        print("[Edge] WARNING: Capture.js not wired. Voice transcription will not work.");
    }

    // Verify display reference
    if (script.display && script.display.api) {
        print("[Edge] Display.js wired OK");
    } else {
        print("[Edge] WARNING: Display.js not wired. HUD output will not work.");
    }
});

// ----------------------------------------------------------------
// Update loop -- frame capture timer
// ----------------------------------------------------------------

script.createEvent("UpdateEvent").bind(function() {
    if (!recording) {
        return;
    }

    frameTimer += getDeltaTime();
    if (frameTimer >= FRAME_INTERVAL) {
        frameTimer = 0;
        captureAndSendFrame();
    }
});

// ----------------------------------------------------------------
// Button event
// TODO: wire to left button hardware event when ButtonComponent
//       or SIK (Spectacles Interaction Kit) is available.
//       For now, call script.api.toggleRecording() from Inspector
//       or from another script that detects the hardware button.
// ----------------------------------------------------------------
