package com.ayhanbatuhan.pdfaraclari;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * "Paylaş → PDF Araçları" ve "Birlikte aç" ile gelen PDF'leri uygulamanın
 * önbelleğine kopyalar; JavaScript tarafı getPending() ile alır.
 */
@CapacitorPlugin(name = "SharedFiles")
public class SharedFilesPlugin extends Plugin {

    private static final List<JSObject> pending = new ArrayList<>();
    private static SharedFilesPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSArray files = new JSArray();
        synchronized (pending) {
            for (JSObject f : pending) files.put(f);
            pending.clear();
        }
        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    /** Activity'ye gelen intent'teki PDF'leri arka planda kopyalar. */
    static void handleIntent(Context ctx, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = getStream(intent);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = getStreams(intent);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        }
        if (uris.isEmpty()) return;

        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            File dir = new File(app.getCacheDir(), "shared");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            int i = 0;
            for (Uri uri : uris) {
                try {
                    String name = displayName(app.getContentResolver(), uri);
                    if (name == null || name.isEmpty()) name = "paylasilan_" + (i + 1) + ".pdf";
                    if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
                    File out = new File(dir, System.currentTimeMillis() + "_" + (i++) + "_" + name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                    try (InputStream in = app.getContentResolver().openInputStream(uri);
                         OutputStream os = new FileOutputStream(out)) {
                        if (in == null) continue;
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    }
                    JSObject f = new JSObject();
                    f.put("path", out.getAbsolutePath());
                    f.put("name", name);
                    synchronized (pending) { pending.add(f); }
                } catch (Exception ignored) {
                    // okunamayan dosya atlanır
                }
            }
            if (instance != null) instance.notifyListeners("filesReceived", new JSObject(), true);
        }).start();
    }

    @SuppressWarnings("deprecation")
    private static Uri getStream(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> getStreams(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    private static String displayName(ContentResolver cr, Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).getName();
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        }
        return null;
    }
}
