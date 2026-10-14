package com.rommancer.sync

import android.content.Context

/**
 * What a sync did, fact by fact, collected across its steps. The UI renders it translated (one fact per line, only
 * the ones that are not zero); the log keeps its English shorthand. Same keys as the console clients' "sum" lines.
 */
class Summary {
    var savesUp = 0
    var savesDown = 0
    var statesUp = 0
    var statesDown = 0
    var gamesDown = 0
    var gamesSent = 0
    var gamesDeleted = 0
    var savesCleaned = 0
    var stopped = false
    var noSpace: String? = null
    /** Where the downloaded games show, for the frontend here: "esde" or "daijisho" */
    var gamesShow: String? = null
    var conflicts = 0
    var errors = 0
    val details = mutableListOf<String>()

    fun error(what: String, e: Throwable) {
        errors++
        details += "$what: ${e.message ?: e.javaClass.simpleName}"
    }

    operator fun plusAssign(o: Summary) {
        savesUp += o.savesUp; savesDown += o.savesDown; statesUp += o.statesUp; statesDown += o.statesDown
        gamesDown += o.gamesDown; gamesSent += o.gamesSent; gamesDeleted += o.gamesDeleted; savesCleaned += o.savesCleaned
        stopped = stopped || o.stopped
        noSpace = o.noSpace ?: noSpace
        gamesShow = o.gamesShow ?: gamesShow
        conflicts = maxOf(conflicts, o.conflicts)
        errors += o.errors
        details += o.details
    }

    fun encode(): String = buildList {
        fun put(key: String, n: Int) { if (n != 0) add("$key\t$n") }
        put("saves-up", savesUp); put("saves-down", savesDown); put("states-up", statesUp); put("states-down", statesDown)
        put("games-down", gamesDown); put("games-sent", gamesSent); put("games-deleted", gamesDeleted); put("saves-cleaned", savesCleaned)
        if (stopped) add("games-stopped\t1")
        noSpace?.let { add("games-nospace\t1\t$it") }
        gamesShow?.let { add("games-show\t1\t$it") }
        put("conflicts", conflicts); put("errors", errors)
        details.forEach { add("detail\t" + it.replace('\n', ' ').replace('\t', ' ')) }
    }.joinToString("\n")

    /** Translated facts, one per line; "All up to date" when there is none */
    fun lines(context: Context): List<String> {
        val r = context.resources
        fun q(id: Int, n: Int) = r.getQuantityString(id, n, n)
        val out = buildList {
            if (savesUp > 0) add(q(R.plurals.sum_saves_up, savesUp))
            if (savesDown > 0) add(q(R.plurals.sum_saves_down, savesDown))
            if (statesUp > 0) add(q(R.plurals.sum_states_up, statesUp))
            if (statesDown > 0) add(q(R.plurals.sum_states_down, statesDown))
            if (gamesDown > 0) add(q(R.plurals.sum_games_down, gamesDown))
            when (gamesShow) {
                "esde" -> add(context.getString(R.string.sum_games_show_esde))
                "daijisho" -> add(context.getString(R.string.sum_games_show_daijisho))
            }
            if (gamesSent > 0) add(q(R.plurals.sum_games_sent, gamesSent))
            if (gamesDeleted > 0) add(q(R.plurals.sum_games_deleted, gamesDeleted))
            if (savesCleaned > 0) add(q(R.plurals.sum_saves_cleaned, savesCleaned))
            if (stopped) add(context.getString(R.string.sum_games_stopped))
            noSpace?.let { add(context.getString(R.string.sum_games_nospace, it)) }
            if (conflicts > 0) add(q(R.plurals.sum_conflicts, conflicts))
            if (errors > 0) add(q(R.plurals.sum_errors, errors))
        }
        return out.ifEmpty { listOf(context.getString(R.string.sum_up_to_date)) }
    }

    companion object {
        fun decode(text: String): Summary = Summary().apply {
            for (f in text.lines().map { it.split('\t') }.filter { it.size >= 2 }) {
                val n = f[1].toIntOrNull() ?: 0
                when (f[0]) {
                    "saves-up" -> savesUp = n
                    "saves-down" -> savesDown = n
                    "states-up" -> statesUp = n
                    "states-down" -> statesDown = n
                    "games-down" -> gamesDown = n
                    "games-sent" -> gamesSent = n
                    "games-deleted" -> gamesDeleted = n
                    "saves-cleaned" -> savesCleaned = n
                    "games-stopped" -> stopped = true
                    "games-nospace" -> noSpace = f.getOrNull(2)
                    "games-show" -> gamesShow = f.getOrNull(2)
                    "conflicts" -> conflicts = n
                    "errors" -> errors = n
                    "detail" -> details += f[1]
                }
            }
        }

        private val STATE = Regex("\\.(state|ppst|p2s|dst|ml\\d|ss\\d|st\\d)(\\d+|\\.auto)?$")

        /** A savestate rather than a save, told by its file name (the emulators' state extensions) */
        fun isState(path: String) = STATE.containsMatchIn(path.substringAfterLast('/').lowercase())
    }
}
