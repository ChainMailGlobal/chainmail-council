// Intro.js -- Startup text
// "ChainMail" appears, holds 2 seconds, fades 0.5 seconds, disappears.
// Runs once. Never again.

// @input Component.Text chainmailText {"label":"ChainMail Text"}
// @input SceneObject introObject {"label":"Intro Object"}

var HOLD_DURATION = 2.0;
var FADE_DURATION = 0.5;
var fadeElapsed = 0;
var fading = false;

function setAlpha(textComp, alpha) {
    if (!textComp) {
        return;
    }
    try {
        var color = textComp.textFill.color;
        textComp.textFill.color = new vec4(color.r, color.g, color.b, alpha);
    } catch (e) {
        try {
            var c = textComp.color;
            textComp.color = new vec4(c.r, c.g, c.b, alpha);
        } catch (e2) {
            // Silent
        }
    }
}

// ----------------------------------------------------------------
// Fade update
// ----------------------------------------------------------------

var fadeEvent = script.createEvent("UpdateEvent");
fadeEvent.enabled = false;

fadeEvent.bind(function() {
    if (!fading) {
        return;
    }

    fadeElapsed += getDeltaTime();
    var progress = fadeElapsed / FADE_DURATION;

    if (progress >= 1.0) {
        progress = 1.0;
    }

    var alpha = 1.0 - progress;
    setAlpha(script.chainmailText, alpha);

    if (progress >= 1.0) {
        // Done -- disable everything
        fading = false;
        fadeEvent.enabled = false;

        if (script.chainmailText) {
            script.chainmailText.text = "";
        }

        if (script.introObject) {
            script.introObject.enabled = false;
        }

        print("[Intro] Complete -- intro disabled");
    }
});

// ----------------------------------------------------------------
// Init
// ----------------------------------------------------------------

script.createEvent("OnStartEvent").bind(function() {
    print("[Intro] Showing ChainMail");

    // Set text and full alpha
    if (script.chainmailText) {
        script.chainmailText.text = "ChainMail";
        setAlpha(script.chainmailText, 1.0);
    }

    // After hold duration, start fade
    var holdEvent = script.createEvent("DelayedCallbackEvent");
    holdEvent.bind(function() {
        print("[Intro] Starting fade");
        fading = true;
        fadeElapsed = 0;
        fadeEvent.enabled = true;
    });
    holdEvent.reset(HOLD_DURATION);
});
