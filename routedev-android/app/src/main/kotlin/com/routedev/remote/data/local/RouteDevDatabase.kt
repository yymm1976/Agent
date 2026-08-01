package com.routedev.remote.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [SessionEntity::class, TimelineEventEntity::class, PendingMessageEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class RouteDevDatabase : RoomDatabase() {
    abstract fun routeDevDao(): RouteDevDao

    companion object {
        fun create(context: Context): RouteDevDatabase =
            Room.databaseBuilder(context, RouteDevDatabase::class.java, "routedev-remote.db")
                .fallbackToDestructiveMigrationOnDowngrade(true)
                .build()
    }
}
