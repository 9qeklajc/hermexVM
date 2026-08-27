package ai.hermex.vm;

import android.os.Bundle;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // hermexVM manages its own safe-area padding in CSS, but Android 15
        // otherwise forces the entire WebView behind the status/navigation
        // bars. Keep the WebView inside the system-bar content area so the
        // conversation header never covers the clock or battery indicators.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    }
}
