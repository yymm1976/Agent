package com.routedev.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.routedev.remote.ui.MainViewModel
import com.routedev.remote.ui.RouteDevApp
import com.routedev.remote.ui.theme.RouteDevTheme

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            RouteDevTheme {
                RouteDevApp(
                    viewModel = viewModel,
                    initialSessionId = intent.getStringExtra(EXTRA_SESSION_ID),
                )
            }
        }
    }

    companion object {
        const val EXTRA_SESSION_ID = "session_id"
    }
}
