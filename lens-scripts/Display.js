// Display.js -- Pure HUD renderer
// Does what it is told. No logic.

// @input Component.Text responseText {"label":"Response Text"}
// @input Component.Text agentLabel {"label":"Agent Label"}
// @input SceneObject recordingDot {"label":"Recording Dot"}
// @input Component.AudioComponent audioOut {"label":"Audio Output"}

var FADE_DELAY = 8.0;
var FADE_DURATION = 0.5;
var fadeElapsed = 0;
var fadeActive = false;
var fadeDelayTimer = 0;
var waitingToFade = false;

// ----------------------------------------------------------------
// Text display
// ----------------------------------------------------------------

function setTextAlpha(textComp, alpha) {
    if (!textComp) {
        return;
    }
    try {
        var color = textComp.textFill.color;
        textComp.textFill.color = new vec4(color.r, color.g, color.b, alpha);
    } catch (e) {
        // Fallback: try direct color property
        try {
            var c = textComp.color;
            textComp.color = new vec4(c.r, c.g, c.b, alpha);
        } catch (e2) {
            // Silent -- alpha control may not be available
        }
    }
}

script.api.showText = function(agentName, text) {
    // Set agent label
    if (script.agentLabel) {
        script.agentLabel.text = agentName || "";
        setTextAlpha(script.agentLabel, 1.0);
    }

    // Set response text
    if (script.responseText) {
        script.responseText.text = text || "";
        setTextAlpha(script.responseText, 1.0);
    }

    // Reset fade timers
    fadeActive = false;
    fadeElapsed = 0;
    fadeDelayTimer = 0;
    waitingToFade = true;

    print("[Display] Show: [" + (agentName || "") + "] " + (text || "").substring(0, 60));
};

script.api.hideText = function() {
    if (script.agentLabel) {
        script.agentLabel.text = "";
        setTextAlpha(script.agentLabel, 0);
    }

    if (script.responseText) {
        script.responseText.text = "";
        setTextAlpha(script.responseText, 0);
    }

    fadeActive = false;
    waitingToFade = false;
    fadeElapsed = 0;
    fadeDelayTimer = 0;
};

// ----------------------------------------------------------------
// Recording indicator
// ----------------------------------------------------------------

script.api.showRecording = function(active) {
    if (script.recordingDot) {
        script.recordingDot.enabled = !!active;
    }
    print("[Display] Recording dot: " + (active ? "ON" : "OFF"));
};

// ----------------------------------------------------------------
// Audio playback
// ----------------------------------------------------------------

script.api.playAudio = function(base64Audio) {
    if (!base64Audio) {
        return;
    }

    if (!script.audioOut) {
        print("[Display] WARNING: No AudioComponent wired. Cannot play audio.");
        return;
    }

    try {
        // Attempt to decode base64 audio and play
        // Lens Studio AudioComponent may not support direct base64 decode
        // This is a best-effort approach
        if (script.audioOut.audioTrack && script.audioOut.audioTrack.loadFromBase64) {
            script.audioOut.audioTrack.loadFromBase64(base64Audio);
            script.audioOut.play(1);
            print("[Display] Playing audio response");
        } else {
            print("[Display] WARNING: AudioComponent does not support base64 loading.");
            print("[Display] Audio data length: " + base64Audio.length + " chars");
        }
    } catch (e) {
        print("[Display] Audio playback error: " + e);
    }
};

// ----------------------------------------------------------------
// Fade logic -- UpdateEvent
// ----------------------------------------------------------------

script.createEvent("UpdateEvent").bind(function() {
    var dt = getDeltaTime();

    // Waiting for fade delay
    if (waitingToFade) {
        fadeDelayTimer += dt;
        if (fadeDelayTimer >= FADE_DELAY) {
            waitingToFade = false;
            fadeActive = true;
            fadeElapsed = 0;
        }
        return;
    }

    // Active fade
    if (fadeActive) {
        fadeElapsed += dt;
        var progress = fadeElapsed / FADE_DURATION;

        if (progress >= 1.0) {
            progress = 1.0;
            fadeActive = false;
        }

        var alpha = 1.0 - progress;

        setTextAlpha(script.responseText, alpha);
        setTextAlpha(script.agentLabel, alpha);

        if (progress >= 1.0) {
            // Fade complete -- clear text
            if (script.responseText) {
                script.responseText.text = "";
            }
            if (script.agentLabel) {
                script.agentLabel.text = "";
            }
        }
    }
});

// ----------------------------------------------------------------
// Init -- hide everything
// ----------------------------------------------------------------

script.createEvent("OnStartEvent").bind(function() {
    print("[Display] Initializing -- hiding all HUD elements");

    if (script.responseText) {
        script.responseText.text = "";
        setTextAlpha(script.responseText, 0);
    }

    if (script.agentLabel) {
        script.agentLabel.text = "";
        setTextAlpha(script.agentLabel, 0);
    }

    if (script.recordingDot) {
        script.recordingDot.enabled = false;
    }

    print("[Display] Ready");
});
