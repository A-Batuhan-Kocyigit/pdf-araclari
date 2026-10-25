package com.ayhanbatuhan.pdfaraclari;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SharedFilesPlugin.class);
        super.onCreate(savedInstanceState);
        SharedFilesPlugin.handleIntent(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        SharedFilesPlugin.handleIntent(this, intent);
    }
}
